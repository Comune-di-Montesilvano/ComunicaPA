import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import type { AnprResidenzaResult, AnprGeneralita, AnprResidenza } from './anpr.types';

const ANPR_C020_BASE_URL =
  'https://modipa.anpr.interno.it/govway/rest/in/MinInternoPortaANPR-PDND/C020-servizioAccertamentoResidenza/v1';
const ANPR_C020_ENDPOINT = `${ANPR_C020_BASE_URL}/anpr-service-e002`;

interface RispostaE002OK {
  idOperazioneANPR?: string;
  listaSoggetti?: {
    datiSoggetto?: Array<{
      generalita: AnprGeneralita;
      residenza?: AnprResidenza[];
      identificativi?: { idANPR?: string };
    }>;
  };
}

/**
 * Integrazione ANPR C020 "Servizio di accertamento residenza" via PDND.
 * Solo interrogazione puntuale per ora (query sempre su prod, mai test/val —
 * stesso pattern di InadService). Richiede, oltre al bearer voucher PDND, i
 * due header Agid-JWT-Signature/Agid-JWT-TrackingEvidence (pattern PDND
 * INTEGRITY_REST_02/AUDIT_REST_02) firmati con la stessa chiave del client.
 */
@Injectable()
export class AnprService {
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

    const voucher = await this.pdndAuth.getVoucher('prod', purposeId);

    const body = {
      idOperazioneClient: randomUUID(),
      criteriRicerca: { codiceFiscale },
      datiRichiesta: {
        dataRiferimentoRichiesta: new Date().toISOString().slice(0, 10),
        motivoRichiesta: 'comunicapa-cerca-domicilio',
        casoUso: 'C020',
      },
    };
    const bodyStr = JSON.stringify(body);
    const digest = `SHA-256=${createHash('sha256').update(bodyStr).digest('base64')}`;

    const [signature, trackingEvidence] = await Promise.all([
      this.pdndAuth.signAgidJwt('prod', ANPR_C020_ENDPOINT, {
        signed_headers: [{ digest }, { 'content-type': 'application/json' }],
      }),
      this.pdndAuth.signAgidJwt('prod', ANPR_C020_ENDPOINT, {
        userID: operatorUsername,
        userLocation,
        LoA: loA,
      }),
    ]);

    const response = await fetch(ANPR_C020_ENDPOINT, {
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

    if (response.status === 404) {
      return { found: false };
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`ANPR C020 fallito: HTTP ${response.status} — ${text.slice(0, 500)}`);
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
      },
    };
  }
}
