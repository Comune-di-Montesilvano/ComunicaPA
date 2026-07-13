import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { ChannelLogFn, IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import { ProtocolloService } from '../../protocollo/protocollo.service';
import { AttachmentService } from '../../attachments/attachment.service';
import { resolveAttachmentsConfig } from '../../attachments/attachment.service';
import { resolvePaymentData } from '../payment-config.util';
import { SendAttachmentUploadService } from './send-attachment-upload.service';

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

function splitFullName(fullName: string | null | undefined): { nome: string; cognome: string } {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { nome: '', cognome: '' };
  if (parts.length === 1) return { nome: parts[0], cognome: '' };
  return { nome: parts.slice(0, -1).join(' '), cognome: parts[parts.length - 1] };
}

@Injectable()
export class SendStrategy implements IChannelStrategy {
  private readonly logger = new Logger(SendStrategy.name);
  readonly channel: NotificationChannel = 'SEND';

  constructor(
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
    private readonly protocollo: ProtocolloService,
    private readonly attachments: AttachmentService,
    private readonly attachmentUpload: SendAttachmentUploadService,
  ) {}

  async send(recipient: Recipient, campaign: Campaign, onLog?: ChannelLogFn): Promise<ChannelSendResult> {
    const log = (msg: string): void => {
      this.logger.debug(msg);
      onLog?.(msg);
    };

    const cfg = campaign.channelConfig as Record<string, unknown>;
    if (cfg['protocolla'] !== true) {
      throw new Error('Protocollazione obbligatoria per SEND: channelConfig.protocolla deve essere true');
    }

    const env = await this.settings.get<string>('send.environment');
    const envKey = env === 'produzione' ? 'prod' : 'test';
    const prefix = `send.${envKey}`;
    const baseUrl = await this.settings.get<string>(`${prefix}.baseUrl` as SettingKey);
    const purposeId = await this.settings.get<string>(`${prefix}.purposeId` as SettingKey);
    const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);

    const vars: Record<string, string> = {
      fullName: recipient.fullName ?? '',
      codiceFiscale: recipient.codiceFiscale,
    };
    const subject = interpolate((cfg['subject'] as string) ?? campaign.name, vars);

    // 1. Protocollazione (obbligatoria per SEND) — fornisce paProtocolNumber.
    log(`Protocollazione SEND per CF ${recipient.codiceFiscale}`);
    const { nome, cognome } = splitFullName(recipient.fullName);
    const protocolloDocBuffer = await this.attachments.generatePdfBuffer(recipient, 0);
    const protocolloResult = await this.protocollo.protocolla({
      oggetto: subject,
      destinatario: {
        codiceFiscale: recipient.codiceFiscale,
        nome,
        cognome,
        denominazione: recipient.fullName ?? recipient.codiceFiscale,
      },
      documentBuffer: protocolloDocBuffer,
      documentFilename: `${recipient.codiceFiscale}.pdf`,
    });
    log(`Protocollazione OK: ${protocolloResult.numeroProtocollo}/${protocolloResult.annoProtocollo}`);
    const paProtocolNumber = `${protocolloResult.numeroProtocollo}/${protocolloResult.annoProtocollo}`;

    // 2. Documenti: uno o più allegati, caricati via preload + upload S3.
    const attachmentsConfig = resolveAttachmentsConfig(campaign.channelConfig);
    const docCount = Math.max(attachmentsConfig.length, 1);
    const documents: Array<Record<string, unknown>> = [];
    for (let idx = 0; idx < docCount; idx++) {
      const buffer = idx === 0 ? protocolloDocBuffer : await this.attachments.generatePdfBuffer(recipient, idx);
      const uploaded = await this.attachmentUpload.preloadAndUpload(baseUrl, voucher, buffer, 'application/pdf', `doc-${idx}`);
      documents.push({
        ref: { key: uploaded.key, versionToken: uploaded.versionToken },
        title: subject,
        digests: { sha256: uploaded.sha256Base64 },
        contentType: 'application/pdf',
        docIdx: idx,
      });
    }

    // 3. Pagamento pagoPA (opzionale) — solo dati, nessun PDF bollettino.
    // ResolvedPaymentData ha campi nullable indipendenti (noticeCode/amountCents
    // possono essere null anche quando l'oggetto stesso non è null, es. quando
    // risolve solo dueDateIso): il pagamento è incluso solo se noticeCode e
    // amountCents risolvono entrambi (stesso gating di app-io.strategy.ts).
    const paymentConfig = campaign.channelConfig?.['paymentConfig'] as Record<string, unknown> | undefined;
    const resolvedPayment = resolvePaymentData(recipient, paymentConfig);
    const payments =
      resolvedPayment?.noticeCode && resolvedPayment.amountCents != null
        ? [{ pagoPa: { noticeCode: resolvedPayment.noticeCode, creditorTaxId: resolvedPayment.creditorTaxId, applyCost: true } }]
        : undefined;

    // 4. Payload completo.
    const senderTaxId = await this.settings.get<string>('send.senderTaxId' as SettingKey);
    const senderDenomination = await this.settings.get<string>('brand.name' as SettingKey);
    const taxonomyCode = cfg['taxonomyCode'] as string;
    const physicalCommunicationType = (cfg['physicalCommunicationType'] as string) || 'AR_REGISTERED_LETTER';

    const payload: Record<string, unknown> = {
      idempotenceToken: randomUUID(),
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

    log(`Invio notifica SEND a CF ${recipient.codiceFiscale} via ${baseUrl} (subject="${subject}")`);
    const response = await fetch(`${baseUrl}/delivery/v2.6/requests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${voucher}`,
      },
      body: JSON.stringify(payload),
    });
    log(`Risposta SEND per CF ${recipient.codiceFiscale}: HTTP ${response.status}`);

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`SEND API error: HTTP ${response.status}${detail ? ` — ${detail.slice(0, 500)}` : ''}`);
    }

    const data = (await response.json()) as { notificationRequestId: string };
    this.logger.log(`Notifica SEND accettata per CF ${recipient.codiceFiscale}: notificationRequestId=${data.notificationRequestId}`);
    return {
      messageId: data.notificationRequestId,
      responsePayload: {
        notificationRequestId: data.notificationRequestId,
        protocollo: protocolloResult,
      },
    };
  }
}
