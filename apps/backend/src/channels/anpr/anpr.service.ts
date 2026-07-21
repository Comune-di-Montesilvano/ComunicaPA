import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { decode as jwtDecodeComplete } from 'jsonwebtoken';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import type { AnprResidenzaResult, AnprGeneralita, AnprResidenza, AnprInfoSoggettoEnte } from './anpr.types';

const ANPR_C002_BASE_URL =
  'https://modipa.anpr.interno.it/govway/rest/in/MinInternoPortaANPR-PDND/C002-servizioComunicazione/v1';
const ANPR_C002_ENDPOINT = `${ANPR_C002_BASE_URL}/anpr-service-e002`;

// aud per Agid-JWT-Signature/Agid-JWT-TrackingEvidence: URL SENZA "-PDND" e
// SENZA il segmento operazione finale — diverso dall'URL di invocazione
// reale sopra. Confermato dal supporto ANPR (issue italia/anpr#3964): un aud
// sbagliato (con -PDND o con /anpr-service-e002 in coda) è la causa più
// comune di InteroperabilityInvalidRequest in quel thread.
const ANPR_C002_AUD = 'https://modipa.anpr.interno.it/govway/rest/in/MinInternoPortaANPR/C002-servizioComunicazione/v1';

interface RispostaE002OK {
  idOperazioneANPR?: string;
  listaSoggetti?: {
    datiSoggetto?: Array<{
      generalita: AnprGeneralita;
      residenza?: AnprResidenza[];
      identificativi?: { idANPR?: string };
      infoSoggettoEnte?: AnprInfoSoggettoEnte[];
    }>;
  };
}

/**
 * Integrazione ANPR C002 "Servizio di comunicazione" via PDND — sostituisce
 * C020 "Servizio di accertamento residenza": stesso schema
 * RichiestaE002/RispostaE002OK e stesso pattern di sicurezza, ma C002 è un
 * superset (restituisce anche esistenza in vita e, se presente, domicilio
 * digitale oltre a generalità/residenza — tramite `infoSoggettoEnte`,
 * coppie chiave/valore generiche: le chiavi esatte usate da ANPR per questi
 * due dati non sono documentate nello spec, vanno lette dal vivo). Solo
 * interrogazione puntuale per ora (query sempre su prod, mai test/val —
 * stesso pattern di InadService).
 *
 * Pattern di sicurezza verificato contro il supporto ufficiale ANPR (issue
 * github.com/italia/anpr#3964, non contro un riassunto): voucher **Bearer
 * standard** (non DPoP — ipotesi provata e scartata, vedi CLAUDE.md), MA la
 * richiesta voucher a PDND deve includere nella client assertion un claim
 * extra `digest: {alg:"SHA256", value:<hex>}` = hash esadecimale del JWT
 * Agid-JWT-TrackingEvidence — pattern AUDIT_REST_02. Va quindi costruito
 * PRIMA il TrackingEvidence, poi il voucher (che lo referenzia), poi la
 * richiesta vera e propria. `aud` di entrambi i JWS è `ANPR_C002_AUD`
 * (senza "-PDND", senza operazione in coda) — diverso dall'URL reale di
 * invocazione, altra causa comune di errore nello stesso thread.
 */
@Injectable()
export class AnprService {
  private readonly logger = new Logger(AnprService.name);

  constructor(
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
  ) {}

  async getResidenza(codiceFiscale: string, operatorUsername: string): Promise<AnprResidenzaResult> {
    const [purposeId, userLocation, loA] = await Promise.all([
      this.settings.get<string>('anpr.prod.purposeId' as SettingKey),
      this.settings.get<string>('anpr.trackingUserLocation' as SettingKey),
      this.settings.get<string>('anpr.trackingLoA' as SettingKey),
    ]);
    if (!purposeId) {
      throw new Error('Configurazione ANPR (prod) incompleta: purposeId non impostato');
    }

    // 1. Agid-JWT-TrackingEvidence, costruito PRIMA del voucher: PDND deve
    // incorporarne il digest nel voucher stesso (pattern AUDIT_REST_02).
    const trackingEvidence = await this.pdndAuth.signAgidJwt('prod', ANPR_C002_AUD, {
      purposeId,
      dnonce: Date.now().toString(),
      userID: operatorUsername,
      userLocation,
      LoA: loA,
    });
    const trackingDigestHex = createHash('sha256').update(trackingEvidence).digest('hex');

    // 2. Voucher con il digest della tracking evidence nella client assertion.
    const voucher = await this.pdndAuth.getVoucherWithDigest('prod', purposeId, trackingDigestHex);

    // 3. Corpo della richiesta + Agid-JWT-Signature (digest del body, base64).
    // idOperazioneClient: max 30 caratteri per ANPR — un randomUUID() (36 con
    // trattini) viene rifiutato con "Lunghezza del campo ... maggiore del
    // massimo consentito 30". Timestamp ms (13 cifre) + 6 char random bastano
    // per un identificativo univoco entro il limite.
    const idOperazioneClient = `${Date.now()}${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const body = {
      idOperazioneClient,
      criteriRicerca: { codiceFiscale },
      datiRichiesta: {
        dataRiferimentoRichiesta: new Date().toISOString().slice(0, 10),
        motivoRichiesta: 'comunicapa-cerca-domicilio',
        casoUso: 'C002',
      },
    };
    const bodyStr = JSON.stringify(body);
    const digest = `SHA-256=${createHash('sha256').update(bodyStr).digest('base64')}`;

    const signature = await this.pdndAuth.signAgidJwt('prod', ANPR_C002_AUD, {
      signed_headers: [{ digest }, { 'Content-Type': 'application/json' }],
    });

    this.logger.debug(`ANPR request body: ${bodyStr}`);
    this.logger.debug(`ANPR Digest: ${digest}`);
    const decodedSignature = jwtDecodeComplete(signature, { complete: true });
    const decodedTracking = jwtDecodeComplete(trackingEvidence, { complete: true });
    this.logger.debug(`ANPR Agid-JWT-Signature decoded: ${JSON.stringify({ header: decodedSignature?.header, payload: decodedSignature?.payload })}`);
    this.logger.debug(`ANPR Agid-JWT-TrackingEvidence decoded: ${JSON.stringify({ header: decodedTracking?.header, payload: decodedTracking?.payload })}`);

    const response = await fetch(ANPR_C002_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${voucher}`,
        Digest: digest,
        'Agid-JWT-Signature': signature,
        'Agid-JWT-TrackingEvidence': trackingEvidence,
        'Content-Type': 'application/json',
      },
      body: bodyStr,
    });

    const text = await response.text();
    if (response.headers) {
      this.logger.debug(`ANPR response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
    }
    this.logger.debug(`ANPR response HTTP ${response.status}: ${text}`);
    if (response.status === 404) {
      return { found: false };
    }
    if (!response.ok) {
      throw new Error(`ANPR C002 fallito: HTTP ${response.status} — ${text.slice(0, 500)}`);
    }

    let data: RispostaE002OK;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Risposta ANPR non valida (non JSON): ${text.slice(0, 200)}`);
    }

    const soggetto = data.listaSoggetti?.datiSoggetto?.[0];
    if (!soggetto) {
      return { found: false };
    }
    return {
      found: true,
      data: {
        idANPR: soggetto.identificativi?.idANPR,
        generalita: soggetto.generalita,
        residenza: soggetto.residenza ?? [],
        infoSoggettoEnte: soggetto.infoSoggettoEnte ?? [],
      },
    };
  }
}
