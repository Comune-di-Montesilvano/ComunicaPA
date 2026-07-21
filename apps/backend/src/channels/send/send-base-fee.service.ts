import { Injectable, Logger } from '@nestjs/common';
import { AppSettingsService } from '../../settings/app-settings.service';

/**
 * Costo digitale base ("gestione piattaforma", ~1€ nel contratto tipo
 * PN): GET price/{paTaxId}/{noticeCode} lo espone SOLO se la notifica ha
 * un notice pagoPA associato — non sempre il caso. Fallback su
 * send.digitalBaseFeeCents quando il notice manca o la chiamata fallisce.
 * Vedi docs/superpowers/specs/2026-07-21-costo-notifiche-design.md.
 */
@Injectable()
export class SendBaseFeeService {
  private readonly logger = new Logger(SendBaseFeeService.name);

  constructor(private readonly settings: AppSettingsService) {}

  async resolve(
    _envKey: 'test' | 'prod',
    baseUrl: string,
    apiKey: string,
    voucher: string,
    paTaxId: string | null,
    noticeCode: string | null,
  ): Promise<number> {
    const fallback = await this.settings.get<number>('send.digitalBaseFeeCents');

    if (!paTaxId || !noticeCode) return fallback;

    try {
      const res = await fetch(`${baseUrl}/delivery/v2.3/price/${paTaxId}/${noticeCode}`, {
        headers: { 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
      });
      if (!res.ok) {
        this.logger.warn(`price endpoint fallito per paTaxId=${paTaxId} noticeCode=${noticeCode}: HTTP ${res.status}`);
        return fallback;
      }
      const data = (await res.json()) as { sendFee?: number };
      return typeof data.sendFee === 'number' ? data.sendFee : fallback;
    } catch (err: any) {
      this.logger.warn(`Errore chiamata price endpoint: ${err.message}`);
      return fallback;
    }
  }
}
