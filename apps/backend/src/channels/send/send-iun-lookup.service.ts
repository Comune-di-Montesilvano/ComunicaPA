import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AppSettingsService } from '../../settings/app-settings.service.js';
import type { SettingKey } from '../../settings/settings.registry.js';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service.js';
import { errorMessage } from '../../common/error-message.js';
import {
  SendLegalFactsService,
  type PnTimelineElement,
  type SendDocumentItem,
  type SendLegalFactDownloadResult,
} from './send-legal-facts.service.js';
import {
  extractSendStatusHistory,
  extractSendTimeline,
  type SendStatusHistoryEntry,
  type SendTimelineEvent,
} from './send-status-history.util.js';

/**
 * Ricerca dello IUN di una notifica SEND dal numero di protocollo, anche per
 * invii fatti FUORI da ComunicaPA (portale web SEND, altri gestionali), e
 * apertura della notifica trovata.
 *
 * PN espone GET /delivery/v2.6/requests?paProtocolNumber&idempotenceToken:
 * get esatto sulla chiave `senderPaId##protocollo##token`. Il portale SEND
 * non imposta il token → PN lo salva come stringa "null" (verificato dal vivo,
 * anche con più destinatari: un solo IUN per notifica): per quegli invii basta
 * il protocollo esattamente come scritto dall'operatore.
 *
 * Usa una apiKey PN DEDICATA (`send.<env>.lookupApiKey`), mai quella di
 * invio: PN filtra lettura e ricerca sui gruppi della chiave e risponde 404
 * (non 403) se la notifica è di un gruppo non incluso. La chiave di ricerca va
 * creata in self-care senza gruppi (vede tutto l'ente); dare più gruppi alla
 * chiave di invio renderebbe invece obbligatorio `group` nel payload.
 * Senza chiave la funzione non esiste: menu nascosto ed endpoint 404.
 */
export interface SendLookupRecipient {
  index: number;
  recipientType: string;
  denomination: string;
  taxId: string;
}

export type SendIunLookupResult =
  | { found: false }
  | {
      found: true;
      iun: string;
      paProtocolNumber: string;
      requestStatus: string;
      notificationStatus?: string;
      subject?: string;
      sentAt?: string;
      group?: string;
      recipients: SendLookupRecipient[];
    };

export interface SendLookupNotificationDetail {
  iun: string;
  paProtocolNumber: string;
  subject?: string;
  abstract?: string;
  sentAt?: string;
  group?: string;
  senderDenomination?: string;
  notificationStatus?: string;
  /** false dopo i 120 giorni: PN non serve più i documenti notificati. */
  documentsAvailable: boolean;
  statusHistory: SendStatusHistoryEntry[];
  recipients: SendLookupRecipient[];
  /** Timeline PN senza dati di identità; `details.recIndex` lega l'evento al destinatario. */
  timeline: SendTimelineEvent[];
  /** Atti notificati (documento originale depositato dal mittente). */
  notifiedDocuments: Array<{ docIdx: number; title: string }>;
  /** Atti opponibili PN e AAR. */
  sendDocuments: SendDocumentItem[];
}

export const SEND_LOOKUP_MAX_LENGTH = 256;
export const SEND_LOOKUP_DEFAULT_TOKEN = 'null';

// IUN PN: lettere maiuscole, cifre e trattini (es. ABCD-EFGH-IJKL-202601-A-1).
const IUN_RE = /^[A-Z0-9-]{1,64}$/;

interface LookupContext {
  baseUrl: string;
  headers: Record<string, string>;
}

@Injectable()
export class SendIunLookupService {
  private readonly logger = new Logger(SendIunLookupService.name);

  constructor(
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
    private readonly legalFacts: SendLegalFactsService,
  ) {}

  private async envKey(): Promise<'test' | 'prod'> {
    return (await this.settings.get<string>('send.environment')) === 'produzione' ? 'prod' : 'test';
  }

  private async lookupApiKey(envKey: 'test' | 'prod'): Promise<string> {
    return String((await this.settings.get<string>(`send.${envKey}.lookupApiKey` as SettingKey)) ?? '').trim();
  }

  async isEnabled(): Promise<boolean> {
    return (await this.lookupApiKey(await this.envKey())) !== '';
  }

  private async context(): Promise<LookupContext> {
    const envKey = await this.envKey();
    const apiKey = await this.lookupApiKey(envKey);
    if (!apiKey) throw new NotFoundException('Ricerca IUN non configurata');
    const [baseUrl, purposeId] = await Promise.all([
      this.settings.get<string>(`send.${envKey}.baseUrl` as SettingKey),
      this.settings.get<string>(`send.${envKey}.purposeId` as SettingKey),
    ]);
    const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);
    return { baseUrl, headers: { 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` } };
  }

  /**
   * Token sempre "null": è quello degli invii dal portale SEND. Gli invii di
   * altri gestionali hanno un proprio token e qui non si trovano.
   */
  async lookup(protocol: string): Promise<SendIunLookupResult> {
    const paProtocolNumber = String(protocol ?? '').trim();
    const idempotenceToken = SEND_LOOKUP_DEFAULT_TOKEN;
    if (!paProtocolNumber || paProtocolNumber.length > SEND_LOOKUP_MAX_LENGTH) {
      throw new BadRequestException(`Numero di protocollo obbligatorio (max ${SEND_LOOKUP_MAX_LENGTH} caratteri)`);
    }
    const ctx = await this.context();

    const query = `paProtocolNumber=${encodeURIComponent(paProtocolNumber)}&idempotenceToken=${encodeURIComponent(idempotenceToken)}`;
    const { status, body } = await this.get(ctx, `/delivery/v2.6/requests?${query}`);
    if (status === 404) return { found: false };
    if (status === 400) {
      const codes = errorCodes(body);
      throw new BadRequestException(`Richiesta rifiutata da SEND${codes ? ` (${codes})` : ''}`);
    }
    if (status !== 200 || !isRecord(body) || typeof body.iun !== 'string' || !body.iun) {
      this.logger.warn(`Ricerca IUN per protocollo: risposta PN inattesa HTTP ${status}`);
      throw new BadGatewayException(`SEND non disponibile (HTTP ${status})`);
    }

    const result: SendIunLookupResult = {
      found: true,
      iun: body.iun,
      paProtocolNumber: str(body.paProtocolNumber) ?? paProtocolNumber,
      requestStatus: str(body.notificationRequestStatus) ?? '',
      recipients: recipientsOf(body),
    };

    // Il dettaglio è accessorio: se non si legge, lo IUN resta comunque valido.
    try {
      const detail = await this.get(ctx, `/delivery/v2.9/notifications/sent/${encodeURIComponent(body.iun)}`);
      if (detail.status === 200 && isRecord(detail.body)) {
        const d = detail.body;
        assignDefined(result, {
          notificationStatus: str(d.notificationStatus),
          subject: str(d.subject),
          sentAt: str(d.sentAt),
          group: str(d.group),
        });
        const recipients = recipientsOf(d);
        if (recipients.length) result.recipients = recipients;
      } else {
        this.logger.warn(`Ricerca IUN per protocollo: dettaglio ${body.iun} HTTP ${detail.status}`);
      }
    } catch (err) {
      this.logger.warn(`Ricerca IUN per protocollo: dettaglio ${body.iun} non letto: ${errorMessage(err)}`);
    }
    return result;
  }

  async getNotification(iun: string): Promise<SendLookupNotificationDetail> {
    assertIun(iun);
    const ctx = await this.context();
    const { status, body } = await this.get(ctx, `/delivery/v2.9/notifications/sent/${encodeURIComponent(iun)}`);
    if (status === 404) throw new NotFoundException('Notifica non trovata su SEND');
    if (status !== 200 || !isRecord(body)) {
      this.logger.warn(`Dettaglio notifica SEND ${iun} (ricerca IUN): HTTP ${status}`);
      throw new BadGatewayException(`SEND non disponibile (HTTP ${status})`);
    }

    const rawTimeline = Array.isArray(body.timeline) ? (body.timeline as PnTimelineElement[]) : [];
    const detail: SendLookupNotificationDetail = {
      iun,
      paProtocolNumber: str(body.paProtocolNumber) ?? '',
      documentsAvailable: body.documentsAvailable !== false,
      statusHistory: extractSendStatusHistory(body),
      recipients: recipientsOf(body),
      timeline: extractSendTimeline(body),
      notifiedDocuments: (Array.isArray(body.documents) ? body.documents : []).filter(isRecord).map((doc, i) => {
        const idx = Number.parseInt(String(doc.docIdx ?? i), 10);
        return { docIdx: Number.isInteger(idx) ? idx : i, title: str(doc.title) || `Documento ${i + 1}` };
      }),
      sendDocuments: await this.legalFacts.listDocuments(iun, 'lookupApiKey', rawTimeline),
    };
    assignDefined(detail, {
      subject: str(body.subject),
      abstract: str(body.abstract),
      sentAt: str(body.sentAt),
      group: str(body.group),
      senderDenomination: str(body.senderDenomination),
      notificationStatus: str(body.notificationStatus),
    });
    return detail;
  }

  async downloadNotifiedDocument(iun: string, docIdx: number): Promise<SendLegalFactDownloadResult> {
    assertIun(iun);
    await this.assertEnabled();
    return this.legalFacts.downloadNotifiedDocument(iun, docIdx, 'lookupApiKey');
  }

  async downloadSendDocument(iun: string, legalFactId: string): Promise<SendLegalFactDownloadResult> {
    assertIun(iun);
    await this.assertEnabled();
    return this.legalFacts.downloadLegalFact(iun, legalFactId, 'lookupApiKey');
  }

  private async assertEnabled(): Promise<void> {
    if (!(await this.isEnabled())) throw new NotFoundException('Ricerca IUN non configurata');
  }

  private async get(ctx: LookupContext, path: string): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await fetch(`${ctx.baseUrl}${path}`, { headers: ctx.headers });
    } catch (err) {
      throw new BadGatewayException(`SEND non raggiungibile: ${errorMessage(err)}`);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }
}

function assertIun(iun: string): void {
  if (typeof iun !== 'string' || !IUN_RE.test(iun)) throw new BadRequestException('IUN non valido');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function assignDefined<T extends object>(target: T, values: Partial<T>): void {
  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined) (target as Record<string, unknown>)[k] = v;
  }
}

function recipientsOf(body: Record<string, unknown>): SendLookupRecipient[] {
  return (Array.isArray(body.recipients) ? body.recipients : []).filter(isRecord).map((r, index) => ({
    index,
    recipientType: str(r.recipientType) ?? '',
    denomination: str(r.denomination) ?? '',
    taxId: str(r.taxId) ?? '',
  }));
}

function errorCodes(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.errors)) return '';
  return body.errors
    .filter(isRecord)
    .map((e) => str(e.code))
    .filter((c): c is string => !!c)
    .join(', ');
}
