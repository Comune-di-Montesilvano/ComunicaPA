import { Injectable, Logger } from '@nestjs/common';
import { AppSettingsService } from '../../settings/app-settings.service.js';
import { errorMessage } from '../../common/error-message.js';

/** Formati PN (spec B2B): paTaxId 11 cifre, noticeCode 18 cifre. */
const PA_TAX_ID_RE = /^\d{11}$/;
const NOTICE_CODE_RE = /^\d{18}$/;

/** Costo base della notifica e sua provenienza: `pn` = sendFee reale, `config` = send.digitalBaseFeeCents. */
export interface SendBaseFee {
  cents: number;
  source: 'pn' | 'config';
}

/**
 * Costo digitale base ("gestione piattaforma", 1€ + IVA da listino PN).
 * GET price/{paTaxId}/{noticeCode} lo espone SOLO per notifiche con avviso
 * pagoPA (cerca per posizione debitoria). Senza avviso, o se la chiamata
 * fallisce, si usa send.digitalBaseFeeCents.
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
  ): Promise<SendBaseFee> {
    const fallback: SendBaseFee = { cents: await this.settings.get<number>('send.digitalBaseFeeCents'), source: 'config' };

    if (!paTaxId || !noticeCode) return fallback;
    // Valori letti dalla risposta PN e messi nel path: solo il formato atteso.
    if (!PA_TAX_ID_RE.test(paTaxId) || !NOTICE_CODE_RE.test(noticeCode)) {
      this.logger.warn('price endpoint: paTaxId/noticeCode fuori formato, uso il costo configurato');
      return fallback;
    }

    try {
      const res = await fetch(`${baseUrl}/delivery/v2.3/price/${encodeURIComponent(paTaxId)}/${encodeURIComponent(noticeCode)}`, {
        headers: { 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
      });
      if (!res.ok) {
        this.logger.warn(`price endpoint fallito per paTaxId=${paTaxId} noticeCode=${noticeCode}: HTTP ${res.status}`);
        return fallback;
      }
      const data = (await res.json()) as { sendFee?: number };
      return typeof data.sendFee === 'number' ? { cents: data.sendFee, source: 'pn' } : fallback;
    } catch (err) {
      this.logger.warn(`Errore chiamata price endpoint: ${errorMessage(err)}`);
      return fallback;
    }
  }
}
