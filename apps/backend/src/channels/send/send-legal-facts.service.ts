import { Injectable, Logger } from '@nestjs/common';
import { AppSettingsService } from '../../settings/app-settings.service.js';
import type { SettingKey } from '../../settings/settings.registry.js';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service.js';

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
}

interface PnTimelineElement {
  category: string;
  legalFactsIds?: Array<{ key: string; category: string }>;
  details?: { generatedAarUrl?: string; attachments?: Array<{ documentType?: string }> };
}

const AAR_KEY_MARKER = 'PN_AAR-';

export type SendLegalFactDownloadResult =
  | { ready: true; filename: string; contentType: string; buffer: Buffer }
  | { ready: false; retryAfterSeconds?: number; error?: string };

@Injectable()
export class SendLegalFactsService {
  private readonly logger = new Logger(SendLegalFactsService.name);

  constructor(
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
  ) {}

  private async getEnvAndBaseUrl(): Promise<{ envKey: 'test' | 'prod'; baseUrl: string; apiKey: string; purposeId: string }> {
    const env = await this.settings.get<string>('send.environment');
    const envKey = env === 'produzione' ? 'prod' : 'test';
    const baseUrl = await this.settings.get<string>(`send.${envKey}.baseUrl` as SettingKey);
    const apiKey = await this.settings.get<string>(`send.${envKey}.apiKey` as SettingKey);
    const purposeId = await this.settings.get<string>(`send.${envKey}.purposeId` as SettingKey);
    return { envKey, baseUrl, apiKey, purposeId };
  }

  async listLegalFacts(iun: string): Promise<SendLegalFactItem[]> {
    const { envKey, baseUrl, apiKey, purposeId } = await this.getEnvAndBaseUrl();
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
    } catch (err: any) {
      this.logger.warn(`Errore elenco documenti SEND IUN ${iun}: ${err.message}`);
      return [];
    }
  }

  /**
   * Elenco documenti per il backoffice: legal-facts PN + tipo documento dalla
   * timeline + AAR. Se la timeline non risponde degrada all'elenco legal-facts
   * nudo, mai un errore. Il portale cittadini resta su listLegalFacts.
   */
  async listDocuments(iun: string): Promise<SendDocumentItem[]> {
    const legalFacts = await this.listLegalFacts(iun);
    const timeline = await this.fetchTimeline(iun);
    if (!timeline) return legalFacts;

    const documentTypeByKey = new Map<string, string>();
    const aarKeys: string[] = [];
    for (const el of timeline) {
      const documentType = el.details?.attachments?.[0]?.documentType;
      if (documentType) {
        for (const lf of el.legalFactsIds ?? []) documentTypeByKey.set(lf.key, documentType);
      }
      const aar = el.details?.generatedAarUrl;
      if (aar && !aarKeys.includes(aar)) aarKeys.push(aar);
    }

    const items: SendDocumentItem[] = legalFacts.map((lf) => {
      const documentType = lf.category === 'ANALOG_DELIVERY' ? documentTypeByKey.get(lf.legalFactId) : undefined;
      return documentType ? { ...lf, documentType } : lf;
    });
    const aarItems: SendDocumentItem[] = aarKeys.map((key) => ({ legalFactId: key, category: 'AAR' }));
    const ackIndex = items.findIndex((i) => i.category === 'SENDER_ACK');
    items.splice(ackIndex + 1, 0, ...aarItems);
    return items;
  }

  private async fetchTimeline(iun: string): Promise<PnTimelineElement[] | null> {
    const { envKey, baseUrl, apiKey, purposeId } = await this.getEnvAndBaseUrl();
    try {
      const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);
      const res = await fetch(`${baseUrl}/delivery/v2.9/notifications/sent/${iun}`, {
        headers: { 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
      });
      const text = await res.text();
      if (!res.ok) {
        this.logger.warn(`Timeline SEND IUN ${iun} per elenco documenti fallita: HTTP ${res.status} — ${text.slice(0, 300)}`);
        return null;
      }
      return (JSON.parse(text) as { timeline?: PnTimelineElement[] }).timeline ?? [];
    } catch (err: any) {
      this.logger.warn(`Errore timeline SEND IUN ${iun} per elenco documenti: ${err.message}`);
      return null;
    }
  }

  async downloadLegalFact(iun: string, legalFactId: string): Promise<SendLegalFactDownloadResult> {
    const { envKey, baseUrl, apiKey, purposeId } = await this.getEnvAndBaseUrl();
    // L'AAR non è un legal-fact: PN lo serve da /document/AAR (stessa forma
    // di risposta filename/url/retryAfter, verificato dal vivo).
    const metaUrl = legalFactId.includes(AAR_KEY_MARKER)
      ? `${baseUrl}/delivery-push/${iun}/document/AAR?documentId=${encodeURIComponent(legalFactId)}`
      : `${baseUrl}/delivery-push/${iun}/download/legal-facts/${encodeURIComponent(legalFactId)}`;
    try {
      const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);
      const metaRes = await fetch(metaUrl, {
        headers: { 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
      });
      const metaText = await metaRes.text();
      if (!metaRes.ok) {
        this.logger.warn(`Metadati download documento SEND IUN ${iun} legalFactId ${legalFactId} falliti: HTTP ${metaRes.status} — ${metaText.slice(0, 300)}`);
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
    } catch (err: any) {
      this.logger.warn(`Errore download documento SEND IUN ${iun} legalFactId ${legalFactId}: ${err.message}`);
      return { ready: false, error: err.message };
    }
  }
}
