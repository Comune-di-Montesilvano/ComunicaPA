import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { AppSettingsService } from '../../settings/app-settings.service.js';
import type { SettingKey } from '../../settings/settings.registry.js';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service.js';
import { captureMessage } from '../../common/sentry.util.js';

/**
 * Elaborazioni massive ANPR usate dalla Verifica Domicili. Stessa API
 * (spec "Consultazione ANPR API C0XX massiva"), cambiano path e caso d'uso:
 * - 'id':   accertamento ID unico nazionale (C030) → CF presente in ANPR
 * - 'vita': verifica dichiarazione esistenza in vita (C007) → S/N
 */
export type AnprMassivoKind = 'id' | 'vita';

interface KindConfig {
  service: string;
  casoUso: string;
  purposeKey: SettingKey;
}

const KINDS: Record<AnprMassivoKind, KindConfig> = {
  id: { service: 'E002AccertamentoIdAnprMassivo', casoUso: 'C030', purposeKey: 'anpr.massivoId.purposeId' as SettingKey },
  // "Verica" (sic) è il nome reale del path nella specifica ufficiale.
  vita: { service: 'E002VericaEsistenzaInVitaMassiva', casoUso: 'C007', purposeKey: 'anpr.massivoVita.purposeId' as SettingKey },
};

const baseUrl = (k: AnprMassivoKind) =>
  `https://modipa.anpr.interno.it/govway/rest/in/MinInternoPortaANPR-PDND/${KINDS[k].service}/v1`;
// aud di Agid-JWT-Signature e Agid-JWT-TrackingEvidence = URL dei `servers`
// della spec, CON "-PDND" — l'opposto di C002/C019 (lì senza "-PDND").
// Con la regola di C002 GovWay risponde 400 InteroperabilityInvalidRequest
// (visto in produzione; supporto ANPR: "claim 'aud' non valido",
// italia/anpr#4662; valore confermato in collaudo in italia/anpr#5425).
const audOf = (k: AnprMassivoKind) => baseUrl(k);

/** Limite ANPR sul file di input compresso (doc ufficiale: 1.500.000 byte). */
export const ANPR_MASSIVO_MAX_GZ_BYTES = 1_500_000;
/** CF per richiesta: ~17 byte/riga, compressi ben sotto il limite. */
export const ANPR_MASSIVO_CHUNK_SIZE = 50_000;

/** Esito per un CF presente nel file di output (i CF assenti non compaiono). */
export interface AnprMassivoEsito {
  /** Solo per 'vita': valore di "Verifica esistenza in vita" (S/N). */
  esistenzaInVita?: 'S' | 'N';
}

export type AnprMassivoDownloadResult =
  | { ready: false; detail: string }
  | { ready: true; esiti: Map<string, AnprMassivoEsito>; entries: number; sample: string };

interface RispostaMassiva {
  risposteMassive?: Array<{
    cf?: string;
    RispostaE002OK?: {
      listaSoggetti?: {
        datiSoggetto?: Array<{
          identificativi?: { idANPR?: string };
          infoSoggettoEnte?: Array<{ chiave?: string; valore?: string }>;
        }>;
      };
    };
  }>;
}

/**
 * Elaborazioni massive ANPR via PDND: un file gzip di CF, esito asincrono
 * (fino a 3 giorni) con una voce per i soli CF presenti. Un CF assente
 * dall'output = mai presente in ANPR o cancellato per motivi diversi dal
 * decesso (doc ufficiale, uguale per C030 e C007).
 *
 * Pattern di sicurezza = C002 (AnprService): TrackingEvidence → voucher con
 * digest → Agid-JWT-Signature. La specifica non ha un endpoint di stato: si
 * prova direttamente il download, finché non risponde 200 l'elaborazione è
 * considerata ancora in corso.
 */
@Injectable()
export class AnprMassivoService {
  private readonly logger = new Logger(AnprMassivoService.name);

  constructor(
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
  ) {}

  async isConfigured(kind: AnprMassivoKind): Promise<boolean> {
    return !!(await this.settings.get<string>(KINDS[kind].purposeKey));
  }

  /** Invia una richiesta di elaborazione; restituisce l'idOperazioneANPR. */
  async start(kind: AnprMassivoKind, cfs: string[], motivoRichiesta: string, operatorUsername: string): Promise<string> {
    const label = `ANPR massivo ${KINDS[kind].casoUso}`;
    const fileGz = gzipSync(Buffer.from(cfs.join('\n') + '\n', 'utf8'));
    if (fileGz.length > ANPR_MASSIVO_MAX_GZ_BYTES) {
      throw new Error(`${label}: file troppo grande (${fileGz.length} byte compressi, max ${ANPR_MASSIVO_MAX_GZ_BYTES})`);
    }
    // idOperazioneClient alfanumerico, max 30 caratteri (stesso vincolo di C002).
    const idOperazioneClient = `${Date.now()}${randomUUID().replace(/-/g, '').slice(0, 6)}`;
    const bodyStr = JSON.stringify({
      idOperazioneClient,
      fileInput: fileGz.toString('base64'),
      datiRichiesta: {
        dataRiferimentoRichiesta: new Date().toISOString().slice(0, 10),
        motivoRichiesta,
        casoUso: KINDS[kind].casoUso,
      },
      // 1 = file di codici fiscali (2 = idANPR, solo per C007).
      tipoRicerca: '1',
    });
    const digest = `SHA-256=${createHash('sha256').update(bodyStr).digest('base64')}`;
    const headers = await this.securityHeaders(kind, operatorUsername, [{ digest }, { 'Content-Type': 'application/json' }]);

    const response = await fetch(`${baseUrl(kind)}/anpr-massivo-e002-richiesta`, {
      method: 'POST',
      headers: { ...headers, Digest: digest, 'Content-Type': 'application/json' },
      body: bodyStr,
    });
    const text = await response.text();
    this.logger.debug(`${label} richiesta HTTP ${response.status}: ${text.slice(0, 1000)}`);
    if (!response.ok) {
      throw new Error(`${label}: richiesta rifiutata, HTTP ${response.status} — ${text.slice(0, 500)}`);
    }
    let data: { idOperazioneANPR?: number | string; stato?: number };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${label}: risposta non JSON: ${text.slice(0, 200)}`);
    }
    if (data.idOperazioneANPR == null) {
      throw new Error(`${label}: risposta senza idOperazioneANPR: ${text.slice(0, 200)}`);
    }
    return String(data.idOperazioneANPR);
  }

  /**
   * Prova a scaricare l'esito. 200 = pronto; altri codici = non ancora
   * disponibile (o errore transitorio), con il dettaglio per la diagnosi.
   * Solo 401/403 sono errori di configurazione (eccezione).
   */
  async download(kind: AnprMassivoKind, idOperazioneAnpr: string, operatorUsername: string): Promise<AnprMassivoDownloadResult> {
    const label = `ANPR massivo ${KINDS[kind].casoUso}`;
    const headers = await this.securityHeaders(kind, operatorUsername, []);
    const response = await fetch(`${baseUrl(kind)}/anpr-massivo-e002-download/resource/${encodeURIComponent(idOperazioneAnpr)}`, {
      method: 'GET',
      headers,
    });
    const buf = Buffer.from(await response.arrayBuffer());
    if (response.status === 401 || response.status === 403) {
      throw new Error(`${label}: download non autorizzato, HTTP ${response.status} — ${buf.toString('utf8').slice(0, 300)}`);
    }
    if (response.status !== 200) {
      return { ready: false, detail: `HTTP ${response.status}: ${buf.toString('utf8').slice(0, 300)}` };
    }
    let parsed: ParsedRispostaMassiva;
    try {
      parsed = parseRispostaMassiva(buf);
    } catch (err) {
      captureMessage(`${label}: esito ANPR illeggibile`, 'error', {
        idOperazioneAnpr, bytes: buf.length, head: maskCfs(buf.subarray(0, 2000).toString('utf8')),
      });
      throw err;
    }
    this.logger.log(`${label} esito ${idOperazioneAnpr}: ${buf.length} byte, ${parsed.entries} voci, ${parsed.esiti.size} CF con soggetto`);
    return { ready: true, esiti: parsed.esiti, entries: parsed.entries, sample: parsed.sample };
  }

  /**
   * Sonda GlitchTip sull'esito scaricato (richiesta dell'ente dopo un esito
   * "tutti assenti" in produzione): conteggi + campione sanificato della
   * risposta, mai CF o anagrafiche in chiaro.
   */
  reportEsito(kind: AnprMassivoKind, idOperazioneAnpr: string, info: { requested: number; matched: number; entries: number; sample: string }): void {
    const anomalo = info.requested > 0 && info.matched === 0;
    captureMessage(
      `ANPR massivo ${KINDS[kind].casoUso}: esito ${anomalo ? 'senza alcun CF riconosciuto' : 'scaricato'} (${info.matched}/${info.requested} CF, ${info.entries} voci)`,
      anomalo ? 'warning' : 'info',
      { idOperazioneAnpr, ...info },
    );
  }

  /**
   * Annulla una richiesta. ANPR lo accetta solo nello stato "inserita"
   * (in pratica pochi istanti, italia/anpr#5425): false se rifiutato.
   */
  async cancel(kind: AnprMassivoKind, idOperazioneAnpr: string, operatorUsername: string): Promise<boolean> {
    const headers = await this.securityHeaders(kind, operatorUsername, []);
    const response = await fetch(`${baseUrl(kind)}/anpr-massivo-e002-delete/resource/${encodeURIComponent(idOperazioneAnpr)}`, {
      method: 'DELETE',
      headers,
    });
    if (response.status === 204 || response.ok) return true;
    this.logger.debug(`ANPR massivo ${KINDS[kind].casoUso} annullamento ${idOperazioneAnpr} rifiutato: HTTP ${response.status} — ${(await response.text()).slice(0, 300)}`);
    return false;
  }

  private async securityHeaders(
    kind: AnprMassivoKind,
    operatorUsername: string,
    signedHeaders: Array<Record<string, string>>,
  ): Promise<Record<string, string>> {
    const aud = audOf(kind);
    const [purposeId, userLocation, loA] = await Promise.all([
      this.settings.get<string>(KINDS[kind].purposeKey),
      this.settings.get<string>('anpr.trackingUserLocation' as SettingKey),
      this.settings.get<string>('anpr.trackingLoA' as SettingKey),
    ]);
    if (!purposeId) throw new Error(`Configurazione ANPR massivo ${KINDS[kind].casoUso} incompleta: purposeId non impostato`);

    const trackingEvidence = await this.pdndAuth.signAgidJwt('prod', aud, {
      purposeId,
      dnonce: Date.now().toString(),
      userID: operatorUsername,
      userLocation,
      LoA: loA,
    });
    const trackingDigestHex = createHash('sha256').update(trackingEvidence).digest('hex');
    const voucher = await this.pdndAuth.getVoucherWithDigest('prod', purposeId, trackingDigestHex);
    const signature = await this.pdndAuth.signAgidJwt('prod', aud, { signed_headers: signedHeaders });
    return {
      Authorization: `Bearer ${voucher}`,
      'Agid-JWT-Signature': signature,
      'Agid-JWT-TrackingEvidence': trackingEvidence,
    };
  }
}

/**
 * Il file di esito è JSON compresso gzip; la specifica lo dichiara
 * `text/plain` `format: byte`, quindi può arrivare anche come base64 del
 * gzip. Si accettano gzip binario, base64 di gzip e JSON in chiaro.
 * Presente = voce con almeno un soggetto nella risposta.
 */
export interface ParsedRispostaMassiva {
  esiti: Map<string, AnprMassivoEsito>;
  /** Voci in risposteMassive (anche senza soggetti). */
  entries: number;
  /** Prime voci, sanificate (sanitizeForProbe), per la diagnosi. */
  sample: string;
}

const CF_RE = /[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]/gi;

/** CF → ultime 4 cifre (stessa convenzione delle query su prod). */
export function maskCfs(text: string): string {
  return text.replace(CF_RE, (cf) => `***${cf.slice(-4)}`);
}

/** Chiavi tecniche il cui valore resta in chiaro nella sonda. */
const PROBE_PLAIN_KEYS = new Set(['chiave', 'valore', 'id', 'idoperazioneanpr', 'stato', 'codiceerroreanomalia', 'testoerroreanomalia', 'tipoerroreanomalia', 'tiporicerca', 'casouso']);

/**
 * Struttura della risposta senza dati personali: chiavi intatte, valori
 * delle chiavi tecniche in chiaro, CF mascherati, ogni altra stringa
 * ridotta a `<str:lunghezza>`.
 */
export function sanitizeForProbe(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.slice(0, 5).map((v) => sanitizeForProbe(v, key)).concat(value.length > 5 ? [`… +${value.length - 5}`] : []);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeForProbe(v, k)]));
  }
  if (typeof value === 'string') {
    if (PROBE_PLAIN_KEYS.has(key.toLowerCase())) return maskCfs(value);
    if (CF_RE.test(value)) { CF_RE.lastIndex = 0; return maskCfs(value); }
    CF_RE.lastIndex = 0;
    return `<str:${value.length}>`;
  }
  return value;
}

/** Proprietà per nome senza distinzione maiuscole/minuscole. */
function prop(obj: unknown, name: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  if (name in o) return o[name];
  const k = Object.keys(o).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? o[k] : undefined;
}

export function parseRispostaMassiva(buf: Buffer): ParsedRispostaMassiva {
  const isGzip = (b: Buffer) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
  let jsonBuf: Buffer;
  if (isGzip(buf)) {
    jsonBuf = gunzipSync(buf);
  } else {
    const text = buf.toString('utf8').trim();
    const decoded = /^[A-Za-z0-9+/=\s]+$/.test(text) ? Buffer.from(text, 'base64') : null;
    jsonBuf = decoded && isGzip(decoded) ? gunzipSync(decoded) : buf;
  }
  let data: unknown;
  try {
    data = JSON.parse(jsonBuf.toString('utf8'));
  } catch {
    throw new Error(`ANPR massivo: esito non leggibile (né gzip né JSON): ${maskCfs(jsonBuf.toString('utf8').slice(0, 200))}`);
  }
  const risposte = prop(data, 'risposteMassive');
  if (!Array.isArray(risposte)) {
    throw new Error(`ANPR massivo: esito senza "risposteMassive": ${JSON.stringify(sanitizeForProbe(data)).slice(0, 300)}`);
  }
  const esiti = new Map<string, AnprMassivoEsito>();
  for (const r of risposte as NonNullable<RispostaMassiva['risposteMassive']>) {
    const lista = prop(prop(r, 'RispostaE002OK'), 'listaSoggetti');
    const rawSoggetti = prop(lista, 'datiSoggetto');
    const soggetti = (Array.isArray(rawSoggetti) ? rawSoggetti : rawSoggetti ? [rawSoggetti] : []) as Array<Record<string, unknown>>;
    // cf della voce; in mancanza, quello del soggetto (schema E002: generalita.codiceFiscale.codFiscale).
    const cfRaw = prop(r, 'cf') ?? prop(r, 'codiceFiscale')
      ?? prop(prop(prop(soggetti[0], 'generalita'), 'codiceFiscale'), 'codFiscale');
    if (typeof cfRaw !== 'string' || !cfRaw.trim() || soggetti.length === 0) continue;
    const info = prop(soggetti[0], 'infoSoggettoEnte');
    const vita = (Array.isArray(info) ? info : [])
      .find((i) => String(prop(i, 'chiave') ?? '').toLowerCase().includes('vita'));
    const v = String(prop(vita, 'valore') ?? '').trim().toUpperCase();
    esiti.set(cfRaw.trim().toUpperCase(), v === 'S' || v === 'N' ? { esistenzaInVita: v } : {});
  }
  const sample = JSON.stringify(sanitizeForProbe(risposte.slice(0, 5))).slice(0, 8000);
  return { esiti, entries: risposte.length, sample };
}
