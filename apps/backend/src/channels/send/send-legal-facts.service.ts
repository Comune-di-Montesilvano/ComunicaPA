import { Injectable, Logger } from '@nestjs/common';
import { AppSettingsService } from '../../settings/app-settings.service.js';
import type { SettingKey } from '../../settings/settings.registry.js';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service.js';
import { PdfExtractorClient } from '../../enrichment/pdf-extractor.client.js';
import { errorMessage } from '../../common/error-message.js';

export interface SendLegalFactItem {
  legalFactId: string;
  category: string;
}

/**
 * Documento SEND per il dettaglio operatore. `category` è quella PN più
 * 'AAR' (avviso di avvenuta ricezione, che PN non elenca tra i legal-facts).
 * `documentType` serve solo per ANALOG_DELIVERY: sotto la stessa categoria PN
 * mette copia conforme dell'AAR spedito, cartolina AR e plico restituito —
 * distinguibili solo da details.attachments[].documentType dell'evento in
 * timeline, mai da nome file o ordine (verificato su IUN reali).
 */
export interface SendDocumentItem extends SendLegalFactItem {
  documentType?: string;
  /** Destinatario (indice in recipients[]) dall'evento di timeline del documento; assente per quelli comuni (SENDER_ACK). */
  recIndex?: number;
}

export interface PnTimelineElement {
  category: string;
  legalFactsIds?: Array<{ key: string; category: string }>;
  details?: { recIndex?: number; generatedAarUrl?: string; attachments?: Array<{ documentType?: string }> };
}

const AAR_KEY_MARKER = 'PN_AAR-';

/** Portale cittadini SEND: destinazione di ripiego se il QR dell'AAR non si legge. */
export const SEND_CITIZEN_PORTAL_URL = 'https://cittadini.notifichedigitali.it/';

/**
 * Link letto dal QR dell'AAR accettato solo se punta a un sito SEND in https
 * (es. https://cittadini.notifichedigitali.it/io/?aar=<token>, verificato su
 * IUN reale): il cittadino ci viene mandato con un click, mai altrove.
 */
export function isSendPortalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password
      && (host === 'notifichedigitali.it' || host.endsWith('.notifichedigitali.it'));
  } catch {
    return false;
  }
}

/**
 * Quale apiKey PN usare: quella di invio (default, gruppo di ComunicaPA) o
 * quella dedicata alla ricerca IUN per protocollo (senza gruppi, vede anche
 * gli invii fatti fuori da ComunicaPA). PN filtra ogni lettura sui gruppi
 * della chiave: con la chiave sbagliata risponde 404.
 */
export type SendApiKeyKind = 'apiKey' | 'lookupApiKey';

export type SendLegalFactDownloadResult =
  | { ready: true; filename: string; contentType: string; buffer: Buffer }
  | { ready: false; retryAfterSeconds?: number; error?: string };

// IUN PN: lettere maiuscole, cifre e trattini (es. ABCD-EFGH-IJKL-202610-A-1).
const IUN_RE = /^[A-Z0-9-]{1,64}$/;
function isValidIun(iun: unknown): iun is string {
  return typeof iun === 'string' && IUN_RE.test(iun);
}

@Injectable()
export class SendLegalFactsService {
  private readonly logger = new Logger(SendLegalFactsService.name);

  constructor(
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
    private readonly pdfExtractor: PdfExtractorClient,
  ) {}

  /**
   * Link di accesso rapido alla notifica su SEND, letto al volo dal QR
   * dell'avviso di avvenuta ricezione (PN non lo espone via API: il token
   * contiene un uuid generato da PN). Niente cache: funzione accessoria, ogni
   * errore (timeline, AAR non pronto, pdf-extractor giù, QR illeggibile) dà
   * null e il chiamante ripiega sul portale cittadini SEND.
   */
  async getQuickAccessUrl(iun: string): Promise<string | null> {
    const timeline = await this.fetchTimeline(iun);
    const aarKey = timeline?.find((el) => el.details?.generatedAarUrl)?.details?.generatedAarUrl;
    if (!aarKey) return null;
    const aar = await this.downloadLegalFact(iun, aarKey);
    if (!aar.ready) return null;
    try {
      const codes = await this.pdfExtractor.qrCodes(aar.buffer, aar.filename);
      return codes.find(isSendPortalUrl) ?? null;
    } catch (err) {
      this.logger.warn(`QR dell'avviso SEND IUN ${iun} non letto: ${errorMessage(err)}`);
      return null;
    }
  }

  private async getEnvAndBaseUrl(keyKind: SendApiKeyKind = 'apiKey'): Promise<{ envKey: 'test' | 'prod'; baseUrl: string; apiKey: string; purposeId: string }> {
    const env = await this.settings.get<string>('send.environment');
    const envKey = env === 'produzione' ? 'prod' : 'test';
    const baseUrl = await this.settings.get<string>(`send.${envKey}.baseUrl` as SettingKey);
    const apiKey = await this.settings.get<string>(`send.${envKey}.${keyKind}` as SettingKey);
    const purposeId = await this.settings.get<string>(`send.${envKey}.purposeId` as SettingKey);
    return { envKey, baseUrl, apiKey, purposeId };
  }

  async listLegalFacts(iun: string, keyKind: SendApiKeyKind = 'apiKey'): Promise<SendLegalFactItem[]> {
    const { envKey, baseUrl, apiKey, purposeId } = await this.getEnvAndBaseUrl(keyKind);
    try {
      const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);
      const res = await fetch(`${baseUrl}/delivery-push/v2.0/${iun}/legal-facts`, {
        headers: { 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
      });
      const text = await res.text();
      if (!res.ok) {
        this.logger.warn(`Elenco documenti SEND IUN ${iun} fallito: HTTP ${res.status} — ${text.slice(0, 300)}`);
        return [];
      }
      const data = JSON.parse(text) as Array<{ legalFactsId: { key: string; category: string } }>;
      return data.map((item) => ({ legalFactId: item.legalFactsId.key, category: item.legalFactsId.category }));
    } catch (err) {
      this.logger.warn(`Errore elenco documenti SEND IUN ${iun}: ${errorMessage(err)}`);
      return [];
    }
  }

  /**
   * Elenco documenti per il backoffice: legal-facts PN + tipo documento dalla
   * timeline + AAR. Se la timeline non risponde degrada all'elenco legal-facts
   * nudo, mai un errore. Il portale cittadini resta su listLegalFacts.
   */
  async listDocuments(iun: string, keyKind: SendApiKeyKind = 'apiKey', knownTimeline?: PnTimelineElement[]): Promise<SendDocumentItem[]> {
    const legalFacts = await this.listLegalFacts(iun, keyKind);
    const timeline = knownTimeline ?? (await this.fetchTimeline(iun, keyKind));
    if (!timeline) return legalFacts;

    const documentTypeByKey = new Map<string, string>();
    const recIndexByKey = new Map<string, number>();
    const aarKeys: string[] = [];
    for (const el of timeline) {
      const documentType = el.details?.attachments?.[0]?.documentType;
      const recIndex = el.details?.recIndex;
      for (const lf of el.legalFactsIds ?? []) {
        if (documentType) documentTypeByKey.set(lf.key, documentType);
        if (typeof recIndex === 'number' && !recIndexByKey.has(lf.key)) recIndexByKey.set(lf.key, recIndex);
      }
      const aar = el.details?.generatedAarUrl;
      if (aar && !aarKeys.includes(aar)) aarKeys.push(aar);
      if (aar && typeof recIndex === 'number' && !recIndexByKey.has(aar)) recIndexByKey.set(aar, recIndex);
    }

    const withRecIndex = (item: SendDocumentItem): SendDocumentItem => {
      const recIndex = recIndexByKey.get(item.legalFactId);
      return recIndex === undefined ? item : { ...item, recIndex };
    };
    const items: SendDocumentItem[] = legalFacts.map((lf) => {
      const documentType = lf.category === 'ANALOG_DELIVERY' ? documentTypeByKey.get(lf.legalFactId) : undefined;
      return withRecIndex(documentType ? { ...lf, documentType } : lf);
    });
    const aarItems: SendDocumentItem[] = aarKeys.map((key) => withRecIndex({ legalFactId: key, category: 'AAR' }));
    const ackIndex = items.findIndex((i) => i.category === 'SENDER_ACK');
    items.splice(ackIndex + 1, 0, ...aarItems);
    return items;
  }

  private async fetchTimeline(iun: string, keyKind: SendApiKeyKind = 'apiKey'): Promise<PnTimelineElement[] | null> {
    if (!isValidIun(iun)) {
      this.logger.warn('Timeline SEND per elenco documenti: IUN non valido, richiesta scartata');
      return null;
    }
    const { envKey, baseUrl, apiKey, purposeId } = await this.getEnvAndBaseUrl(keyKind);
    try {
      const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);
      const res = await fetch(`${baseUrl}/delivery/v2.9/notifications/sent/${encodeURIComponent(iun)}`, {
        headers: { 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
      });
      const text = await res.text();
      if (!res.ok) {
        this.logger.warn(`Timeline SEND IUN ${iun} per elenco documenti fallita: HTTP ${res.status} — ${text.slice(0, 300)}`);
        return null;
      }
      return (JSON.parse(text) as { timeline?: PnTimelineElement[] }).timeline ?? [];
    } catch (err) {
      this.logger.warn(`Errore timeline SEND IUN ${iun} per elenco documenti: ${errorMessage(err)}`);
      return null;
    }
  }

  async downloadLegalFact(iun: string, legalFactId: string, keyKind: SendApiKeyKind = 'apiKey'): Promise<SendLegalFactDownloadResult> {
    // Lo IUN finisce nel path della richiesta a PN; legalFactId deve essere una
    // stringa (non un array da parametro ripetuto in query).
    if (!isValidIun(iun) || typeof legalFactId !== 'string' || !legalFactId) {
      return { ready: false, error: 'IUN o legalFactId non validi' };
    }
    const creds = await this.getEnvAndBaseUrl(keyKind);
    // L'AAR non è un legal-fact: PN lo serve da /document/AAR (stessa forma
    // di risposta filename/url/retryAfter, verificato dal vivo).
    const metaPath = legalFactId.includes(AAR_KEY_MARKER)
      ? `/delivery-push/${encodeURIComponent(iun)}/document/AAR?documentId=${encodeURIComponent(legalFactId)}`
      : `/delivery-push/${encodeURIComponent(iun)}/download/legal-facts/${encodeURIComponent(legalFactId)}`;
    return this.downloadViaMetadata(creds, metaPath, `IUN ${iun} legalFactId ${legalFactId}`);
  }

  /**
   * Documento notificato (l'atto originale depositato dal mittente), indice
   * `docIdx` di `documents[]` della notifica. PN lo serve solo finché
   * `documentsAvailable` è true (120 giorni dal perfezionamento).
   */
  async downloadNotifiedDocument(iun: string, docIdx: number, keyKind: SendApiKeyKind = 'apiKey'): Promise<SendLegalFactDownloadResult> {
    if (!isValidIun(iun) || !Number.isInteger(docIdx) || docIdx < 0 || docIdx > 999) {
      return { ready: false, error: 'IUN o indice documento non validi' };
    }
    const creds = await this.getEnvAndBaseUrl(keyKind);
    return this.downloadViaMetadata(
      creds,
      `/delivery/notifications/sent/${encodeURIComponent(iun)}/attachments/documents/${docIdx}`,
      `IUN ${iun} documento ${docIdx}`,
    );
  }

  /** Metadati PN (filename/url presigned/retryAfter) → contenuto del file. */
  private async downloadViaMetadata(
    { envKey, baseUrl, apiKey, purposeId }: { envKey: 'test' | 'prod'; baseUrl: string; apiKey: string; purposeId: string },
    metaPath: string,
    what: string,
  ): Promise<SendLegalFactDownloadResult> {
    const metaUrl = `${baseUrl}${metaPath}`;
    try {
      const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);
      const metaRes = await fetch(metaUrl, {
        headers: { 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
      });
      const metaText = await metaRes.text();
      if (!metaRes.ok) {
        this.logger.warn(`Metadati download documento SEND ${what} falliti: HTTP ${metaRes.status} — ${metaText.slice(0, 300)}`);
        return { ready: false, error: `Errore PN: HTTP ${metaRes.status}` };
      }
      const meta = JSON.parse(metaText) as { filename: string; url?: string; retryAfter?: number };
      if (!meta.url) {
        return { ready: false, retryAfterSeconds: meta.retryAfter };
      }
      const fileRes = await fetch(meta.url);
      if (!fileRes.ok) {
        return { ready: false, error: `Errore download file: HTTP ${fileRes.status}` };
      }
      const arrayBuffer = await fileRes.arrayBuffer();
      return {
        ready: true,
        filename: meta.filename,
        contentType: fileRes.headers.get('content-type') || 'application/octet-stream',
        buffer: Buffer.from(arrayBuffer),
      };
    } catch (err) {
      this.logger.warn(`Errore download documento SEND ${what}: ${errorMessage(err)}`);
      return { ready: false, error: errorMessage(err) };
    }
  }
}
