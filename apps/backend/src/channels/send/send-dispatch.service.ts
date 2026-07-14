import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { NotificationAttempt, AttemptStatus } from '../../entities/notification-attempt.entity';
import { Campaign } from '../../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../../entities/recipient.entity';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import { AttachmentService, resolveAttachmentsConfig } from '../../attachments/attachment.service';
import { SendAttachmentUploadService } from './send-attachment-upload.service';
import { resolvePaymentData } from '../payment-config.util';
import { getEffectiveRetentionDays } from '../../campaigns/retention.util';

const BATCH_SIZE = 200;

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

/**
 * Demone SEND-specifico: invia a PN gli attempt già protocollati (colonne
 * protocolNumber/protocolYear scritte da ProtocollazioneSyncService) e non
 * ancora inviati. Sostituisce la logica sincrona che era in SendStrategy.send()/
 * job BullMQ — SEND non passa più dalla coda BullMQ (vedi campaigns.service.ts).
 */
@Injectable()
export class SendDispatchService {
  private readonly logger = new Logger(SendDispatchService.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
    private readonly attachments: AttachmentService,
    private readonly attachmentUpload: SendAttachmentUploadService,
  ) {}

  @Cron('*/2 * * * *')
  async handleCron(): Promise<void> {
    const attempts = await this.attemptRepo
      .createQueryBuilder('attempt')
      .leftJoinAndSelect('attempt.recipient', 'recipient')
      .leftJoinAndSelect('recipient.campaign', 'campaign')
      .where('attempt.channel_type = :ch', { ch: 'SEND' })
      .andWhere('attempt.status = :status', { status: AttemptStatus.QUEUED })
      .andWhere('attempt.protocolled_at IS NOT NULL')
      .andWhere("attempt.response_payload ->> 'notificationRequestId' IS NULL")
      .orderBy('attempt.created_at', 'ASC')
      .take(BATCH_SIZE)
      .getMany();

    for (const attempt of attempts) {
      try {
        await this.dispatchOne(attempt);
      } catch (err: any) {
        this.logger.warn(`Invio SEND fallito per attempt ${attempt.id}: ${err.message}`);
        await this.markFailed(attempt, err.message);
      }
    }
  }

  private async dispatchOne(attempt: NotificationAttempt): Promise<void> {
    const recipient = attempt.recipient;
    const campaign = recipient.campaign;
    const cfg = campaign.channelConfig as Record<string, unknown>;

    const env = await this.settings.get<string>('send.environment');
    const envKey = env === 'produzione' ? 'prod' : 'test';
    const prefix = `send.${envKey}`;
    const baseUrl = await this.settings.get<string>(`${prefix}.baseUrl` as SettingKey);
    const purposeId = await this.settings.get<string>(`${prefix}.purposeId` as SettingKey);
    const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);

    const vars: Record<string, string> = { fullName: recipient.fullName ?? '', codiceFiscale: recipient.codiceFiscale };
    const subject = interpolate((cfg['subject'] as string) ?? campaign.name, vars);
    const paProtocolNumber = `${attempt.protocolNumber}/${attempt.protocolYear}`;

    const attachmentsConfig = resolveAttachmentsConfig(campaign.channelConfig);
    const docCount = Math.max(attachmentsConfig.length, 1);
    const documents: Array<Record<string, unknown>> = [];
    for (let idx = 0; idx < docCount; idx++) {
      const buffer = await this.attachments.generatePdfBuffer(recipient, idx);
      const uploaded = await this.attachmentUpload.preloadAndUpload(baseUrl, voucher, buffer, 'application/pdf', `doc-${idx}`);
      documents.push({
        ref: { key: uploaded.key, versionToken: uploaded.versionToken },
        title: subject,
        digests: { sha256: uploaded.sha256Base64 },
        contentType: 'application/pdf',
        docIdx: idx,
      });
    }

    const paymentConfig = cfg['paymentConfig'] as Record<string, unknown> | undefined;
    const resolvedPayment = resolvePaymentData(recipient, paymentConfig);
    const payments =
      resolvedPayment?.noticeCode && resolvedPayment.amountCents != null
        ? [{ pagoPa: { noticeCode: resolvedPayment.noticeCode, creditorTaxId: resolvedPayment.creditorTaxId, applyCost: true } }]
        : undefined;

    const senderTaxId = await this.settings.get<string>('send.senderTaxId' as SettingKey);
    const senderDenomination = await this.settings.get<string>('brand.name' as SettingKey);
    const taxonomyCode = cfg['taxonomyCode'] as string;
    const physicalCommunicationType = (cfg['physicalCommunicationType'] as string) || 'AR_REGISTERED_LETTER';

    const payload: Record<string, unknown> = {
      // Deterministico sull'attemptId: un retry del demone (crash, errore rete)
      // riusa lo stesso token, PN deduplica invece di creare una seconda
      // notifica legale. La protocollazione è già persistita PRIMA che questo
      // demone giri (vedi ProtocollazioneSyncService) — un retry non rifà mai
      // la protocollazione, chiude il rischio di doppio paProtocolNumber.
      idempotenceToken: attempt.id,
      paProtocolNumber,
      notificationFeePolicy: 'FLAT_RATE',
      physicalCommunicationType,
      senderDenomination,
      senderTaxId,
      taxonomyCode,
      subject,
      recipients: [{
        recipientType: 'PF',
        taxId: recipient.codiceFiscale,
        denomination: recipient.fullName ?? recipient.codiceFiscale,
        ...(payments ? { payments } : {}),
      }],
      documents,
    };

    const response = await fetch(`${baseUrl}/delivery/v2.6/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${voucher}` },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`SEND API error: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 500)}` : ''}`);
    }

    const data = (await response.json()) as { notificationRequestId: string };
    this.logger.log(`Notifica SEND accettata per attempt ${attempt.id}: notificationRequestId=${data.notificationRequestId}`);
    await this.markSuccess(attempt, campaign, { notificationRequestId: data.notificationRequestId });
  }

  private async markSuccess(attempt: NotificationAttempt, campaign: Campaign, responsePayload: Record<string, unknown>): Promise<void> {
    const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
    const retentionDays = getEffectiveRetentionDays(campaign, retentionMaxDays);
    const attachmentExpiresAt = new Date(Date.now() + retentionDays * 86400 * 1000);

    attempt.status = AttemptStatus.SUCCESS;
    attempt.sentAt = new Date();
    attempt.responsePayload = responsePayload;
    await this.attemptRepo.save(attempt);
    await this.recipientRepo.update(attempt.recipient.id, { status: RecipientStatus.SENT, attachmentExpiresAt });
    await this.campaignRepo.increment({ id: campaign.id }, 'sentCount', 1);
  }

  private async markFailed(attempt: NotificationAttempt, message: string): Promise<void> {
    attempt.status = AttemptStatus.FAILED;
    attempt.errorMessage = message;
    await this.attemptRepo.save(attempt);
    await this.recipientRepo.update(attempt.recipient.id, { status: RecipientStatus.FAILED });
    await this.campaignRepo.increment({ id: attempt.recipient.campaign.id }, 'failedCount', 1);
  }
}
