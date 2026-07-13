import { Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { ChannelLogFn, IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';
import { ProtocolloService } from '../../protocollo/protocollo.service';
import { AttachmentService } from '../../attachments/attachment.service';

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
  ) {}

  async send(recipient: Recipient, campaign: Campaign, onLog?: ChannelLogFn): Promise<ChannelSendResult> {
    const log = (msg: string): void => {
      this.logger.debug(msg);
      onLog?.(msg);
    };

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
    const cfg = campaign.channelConfig as Record<string, unknown>;
    const subject = interpolate((cfg['subject'] as string) ?? campaign.name, vars);
    const notificationBody = interpolate((cfg['body'] as string) ?? '', vars);

    const extraResponsePayload: Record<string, unknown> = {};
    if (cfg['protocolla'] === true) {
      log(`Protocollazione SEND per CF ${recipient.codiceFiscale}`);
      const { nome, cognome } = splitFullName(recipient.fullName);
      const documentBuffer = await this.attachments.generatePdfBuffer(recipient, 0);
      const protocolloResult = await this.protocollo.protocolla({
        oggetto: subject,
        destinatario: {
          codiceFiscale: recipient.codiceFiscale,
          nome,
          cognome,
          denominazione: recipient.fullName ?? recipient.codiceFiscale,
        },
        documentBuffer,
        documentFilename: `${recipient.codiceFiscale}.pdf`,
      });
      extraResponsePayload.protocollo = protocolloResult;
      log(`Protocollazione OK: ${protocolloResult.numeroProtocollo}/${protocolloResult.annoProtocollo}`);
    }

    log(`Invio notifica SEND a CF ${recipient.codiceFiscale} via ${baseUrl} (subject="${subject}")`);
    // TODO: endpoint e payload reali sono /delivery/v2.6/requests con schema
    // multipart (allegati via preload) — questo resta un placeholder in attesa
    // dell'implementazione del payload notifica completo (sotto-progetto 2).
    const response = await fetch(`${baseUrl}/delivery/notifications/sent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${voucher}`,
      },
      body: JSON.stringify({
        recipientTaxId: recipient.codiceFiscale,
        subject,
        notificationBody,
      }),
    });
    log(`Risposta SEND per CF ${recipient.codiceFiscale}: HTTP ${response.status}`);

    if (!response.ok) {
      throw new Error(`SEND API error: ${response.status}`);
    }

    const data = (await response.json()) as { notificationRequestId: string };
    this.logger.log(`Notifica SEND inviata a CF ${recipient.codiceFiscale}: messageId=${data.notificationRequestId}`);
    return {
      messageId: data.notificationRequestId,
      responsePayload: { ...data, ...extraResponsePayload } as unknown as Record<string, unknown>,
    };
  }
}
