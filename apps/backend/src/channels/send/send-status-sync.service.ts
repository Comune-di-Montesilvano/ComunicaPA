import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { NotificationAttempt } from '../../entities/notification-attempt.entity';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';

const BATCH_SIZE = 200;
const TERMINAL_STATUSES = ['VIEWED', 'EFFECTIVE_DATE', 'UNREACHABLE', 'CANCELLED', 'RETURNED_TO_SENDER', 'REFUSED'];

@Injectable()
export class SendStatusSyncService {
  private readonly logger = new Logger(SendStatusSyncService.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
  ) {}

  @Cron('*/15 * * * *')
  async handleCron(): Promise<void> {
    await this.resolveMissingIun();
    await this.updateStatuses();
  }

  private async getEnvAndBaseUrl(): Promise<{ envKey: 'test' | 'prod'; baseUrl: string; apiKey: string; purposeId: string }> {
    const env = await this.settings.get<string>('send.environment');
    const envKey = env === 'produzione' ? 'prod' : 'test';
    const baseUrl = await this.settings.get<string>(`send.${envKey}.baseUrl` as SettingKey);
    // PN richiede ENTRAMBI gli header su ogni chiamata: x-api-key (portale
    // self-care PN) e Authorization: Bearer <voucher PDND> — confermato dalla
    // documentazione ufficiale developer.pagopa.it (esempio curl verbatim).
    const apiKey = await this.settings.get<string>(`send.${envKey}.apiKey` as SettingKey);
    const purposeId = await this.settings.get<string>(`send.${envKey}.purposeId` as SettingKey);
    return { envKey, baseUrl, apiKey, purposeId };
  }

  async resolveMissingIun(): Promise<void> {
    const { envKey, baseUrl, apiKey, purposeId } = await this.getEnvAndBaseUrl();
    const attempts = await this.attemptRepo
      .createQueryBuilder('attempt')
      .where('attempt.channel_type = :ch', { ch: 'SEND' })
      .andWhere('attempt.iun IS NULL')
      .andWhere("attempt.response_payload ->> 'notificationRequestId' IS NOT NULL")
      // Un attempt REFUSED non avrà mai un IUN: senza questa esclusione resta
      // candidato per sempre ad ogni run del cron, e con BATCH_SIZE=200 senza
      // ORDER BY può saturare il batch a scapito di attempt genuinamente nuovi.
      .andWhere("(attempt.send_status IS NULL OR attempt.send_status <> :refused)", { refused: 'REFUSED' })
      .orderBy('attempt.created_at', 'ASC')
      .take(BATCH_SIZE)
      .getMany();

    if (attempts.length === 0) return;
    const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);

    for (const attempt of attempts) {
      const requestId = (attempt.responsePayload as Record<string, unknown>)['notificationRequestId'] as string;
      try {
        const res = await fetch(`${baseUrl}/delivery/v2.6/requests?requestId=${encodeURIComponent(requestId)}`, {
          headers: { 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
        });
        const text = await res.text();
        if (!res.ok) {
          this.logger.warn(`Verifica richiesta SEND ${requestId} fallita: HTTP ${res.status} — ${text.slice(0, 300)}`);
          continue;
        }
        const data = JSON.parse(text) as { notificationRequestStatus: string; iun?: string; errors?: unknown[] };
        if (data.notificationRequestStatus === 'ACCEPTED' && data.iun) {
          attempt.iun = data.iun;
          attempt.sendStatus = 'ACCEPTED';
          attempt.sendStatusUpdatedAt = new Date();
          await this.attemptRepo.save(attempt);
        } else if (data.notificationRequestStatus === 'REFUSED') {
          attempt.sendStatus = 'REFUSED';
          attempt.sendStatusUpdatedAt = new Date();
          await this.attemptRepo.save(attempt);
          this.logger.warn(`Richiesta SEND ${requestId} rifiutata da PN: ${JSON.stringify(data.errors ?? [])}`);
        }
      } catch (err: any) {
        this.logger.warn(`Errore risoluzione IUN per richiesta SEND ${requestId}: ${err.message}`);
      }
    }
  }

  async updateStatuses(): Promise<void> {
    const { envKey, baseUrl, apiKey, purposeId } = await this.getEnvAndBaseUrl();
    const attempts = await this.attemptRepo
      .createQueryBuilder('attempt')
      .where('attempt.channel_type = :ch', { ch: 'SEND' })
      .andWhere('attempt.iun IS NOT NULL')
      .andWhere('(attempt.send_status IS NULL OR attempt.send_status NOT IN (:...terminal))', { terminal: TERMINAL_STATUSES })
      .orderBy('attempt.created_at', 'ASC')
      .take(BATCH_SIZE)
      .getMany();

    if (attempts.length === 0) return;
    const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);

    for (const attempt of attempts) {
      try {
        const res = await fetch(`${baseUrl}/delivery/v2.9/notifications/sent/${attempt.iun}`, {
          headers: { 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
        });
        const text = await res.text();
        if (!res.ok) {
          this.logger.warn(`Aggiornamento stato SEND IUN ${attempt.iun} fallito: HTTP ${res.status} — ${text.slice(0, 300)}`);
          continue;
        }
        const data = JSON.parse(text) as { notificationStatus: string };
        if (data.notificationStatus && data.notificationStatus !== attempt.sendStatus) {
          attempt.sendStatus = data.notificationStatus;
          attempt.sendStatusUpdatedAt = new Date();
          await this.attemptRepo.save(attempt);
        }
      } catch (err: any) {
        this.logger.warn(`Errore aggiornamento stato SEND IUN ${attempt.iun}: ${err.message}`);
      }
    }
  }
}
