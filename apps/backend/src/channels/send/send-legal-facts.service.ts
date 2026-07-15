import { Injectable, Logger } from '@nestjs/common';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';

export interface SendLegalFactItem {
  legalFactId: string;
  category: string;
}

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

  async downloadLegalFact(iun: string, legalFactId: string): Promise<SendLegalFactDownloadResult> {
    const { envKey, baseUrl, apiKey, purposeId } = await this.getEnvAndBaseUrl();
    try {
      const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);
      const metaRes = await fetch(`${baseUrl}/delivery-push/${iun}/download/legal-facts/${encodeURIComponent(legalFactId)}`, {
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
