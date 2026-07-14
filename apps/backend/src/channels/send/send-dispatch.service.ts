import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
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
  private running = false;

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
    if (this.running) {
      this.logger.warn('Tick precedente di SendDispatchService ancora in corso — salto questo giro per evitare doppio invio.');
      return;
    }
    this.running = true;
    try {
      await this.runOnce();
    } finally {
      this.running = false;
    }
  }

  private async runOnce(): Promise<void> {
    // Due query separate invece di un unico leftJoinAndSelect+orderBy+take:
    // TypeORM (0.3.30) lancia "Cannot read properties of undefined (reading
    // 'databaseName')" in createOrderByCombinedWithSelectExpression quando
    // take()+orderBy() sono combinati con leftJoinAndSelect su relazioni
    // dichiarate per stringa (@ManyToOne('Campaign', ...)) come in questo
    // schema — bug interno riproducibile in isolamento, non risolvibile
    // riordinando le chiamate del query builder. La prima query (nessun join)
    // seleziona solo gli id nell'ordine/limite corretti; la seconda carica le
    // relazioni per quegli id, senza orderBy/take.
    const candidateIds = (
      await this.attemptRepo
        .createQueryBuilder('attempt')
        .select('attempt.id', 'id')
        .where('attempt.channel_type = :ch', { ch: 'SEND' })
        .andWhere('attempt.status = :status', { status: AttemptStatus.QUEUED })
        .andWhere('attempt.protocolled_at IS NOT NULL')
        .andWhere("attempt.response_payload ->> 'notificationRequestId' IS NULL")
        .orderBy('attempt.created_at', 'ASC')
        .take(BATCH_SIZE)
        .getRawMany<{ id: string }>()
    ).map((row) => row.id);

    if (candidateIds.length === 0) return;

    const attempts = await this.attemptRepo.find({
      where: { id: In(candidateIds) },
      relations: { recipient: { campaign: true } },
    });

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
    // PN richiede ENTRAMBI gli header su ogni chiamata: x-api-key (portale
    // self-care PN) e Authorization: Bearer <voucher PDND> — confermato dalla
    // documentazione ufficiale developer.pagopa.it (esempio curl verbatim),
    // non solo dallo spec OpenAPI backend (che documenta solo x-api-key, senza
    // il layer di gateway PDND davanti). Vedi settings.registry.ts.
    const apiKey = await this.settings.get<string>(`${prefix}.apiKey` as SettingKey);
    const purposeId = await this.settings.get<string>(`${prefix}.purposeId` as SettingKey);
    const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);

    const vars: Record<string, string> = { fullName: recipient.fullName ?? '', codiceFiscale: recipient.codiceFiscale };
    const subject = interpolate((cfg['subject'] as string) ?? campaign.name, vars);
    const paProtocolNumber = `${attempt.protocolNumber}/${attempt.protocolYear}`;

    const attachmentsConfig = resolveAttachmentsConfig(campaign.channelConfig);
    const docCount = Math.max(attachmentsConfig.length, 1);
    // Un retry (nuovo attempt, vedi campaigns.service.ts#retryRecipient) può
    // ereditare uploadedDocuments dall'ultimo tentativo dello stesso
    // destinatario: se un documento è già stato caricato su PN in precedenza
    // (es. l'attempt è fallito DOPO l'upload ma PRIMA del POST v2.6/requests),
    // lo riusiamo invece di ricaricarlo — l'oggetto S3 è già lì, gli URL
    // presigned scadono ma key/versionToken restano validi come riferimento.
    const uploadedByIdx = new Map((attempt.uploadedDocuments ?? []).map((d) => [d.docIdx, d]));
    const documents: Array<Record<string, unknown>> = [];
    for (let idx = 0; idx < docCount; idx++) {
      let uploaded = uploadedByIdx.get(idx);
      if (!uploaded) {
        const buffer = await this.attachments.generatePdfBuffer(recipient, idx);
        const result = await this.attachmentUpload.preloadAndUpload(baseUrl, apiKey, voucher, buffer, 'application/pdf', `doc-${idx}`);
        uploaded = { docIdx: idx, key: result.key, versionToken: result.versionToken, sha256Base64: result.sha256Base64 };
        uploadedByIdx.set(idx, uploaded);
        // Scrittura durevole subito dopo ogni upload riuscito: se il demone si
        // ferma a metà di un documento multi-allegato, il prossimo giro (o un
        // retry) non ricarica quelli già presenti su PN.
        attempt.uploadedDocuments = [...uploadedByIdx.values()];
        await this.attemptRepo.update({ id: attempt.id, status: AttemptStatus.QUEUED }, { uploadedDocuments: attempt.uploadedDocuments });
      }
      documents.push({
        ref: { key: uploaded.key, versionToken: uploaded.versionToken },
        title: subject,
        digests: { sha256: uploaded.sha256Base64 },
        contentType: 'application/pdf',
        // docIdx nello schema NotificationDocument di PN è type:string
        // (pattern ^\d+$), non un numero — un numero JSON fa fallire la
        // validazione allOf del documento (errore reale riscontrato:
        // "instance failed to match all required schemas (matched only 1
        // out of 2)", dove i 2 branch sono NotificationAttachment + l'oggetto
        // extra con title/docIdx).
        docIdx: String(idx),
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
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
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

    // Update guardato su status=QUEUED (non blind save): se l'attempt è stato
    // annullato (cancel()) mentre l'invio a PN era in volo, non deve tornare
    // indietro a SUCCESS né gonfiare sentCount per una notifica che l'operatore
    // ha già considerato cancellata.
    const result = await this.attemptRepo.update(
      { id: attempt.id, status: AttemptStatus.QUEUED },
      // responsePayload è una colonna jsonb tipata Record<string, unknown> | null:
      // il tipo _QueryDeepPartialEntity di TypeORM prova a rendere l'oggetto
      // ricorsivamente parziale e non combacia con un Record generico — cast
      // esplicito, stesso pattern necessario per qualunque colonna jsonb "libera".
      { status: AttemptStatus.SUCCESS, sentAt: new Date(), responsePayload } as unknown as Parameters<typeof this.attemptRepo.update>[1],
    );
    if (!result.affected) {
      this.logger.warn(`Attempt ${attempt.id} non più QUEUED (probabile cancel() concorrente) — invio a PN riuscito ma esito SUCCESS non applicato, contatori non toccati.`);
      return;
    }
    await this.recipientRepo.update(attempt.recipient.id, { status: RecipientStatus.SENT, attachmentExpiresAt });
    await this.campaignRepo.increment({ id: campaign.id }, 'sentCount', 1);
  }

  private async markFailed(attempt: NotificationAttempt, message: string): Promise<void> {
    // Stesso guard di markSuccess: non sovrascrivere un attempt non più QUEUED.
    const result = await this.attemptRepo.update(
      { id: attempt.id, status: AttemptStatus.QUEUED },
      { status: AttemptStatus.FAILED, errorMessage: message },
    );
    if (!result.affected) {
      this.logger.warn(`Attempt ${attempt.id} non più QUEUED (probabile cancel() concorrente) — invio a PN fallito ma esito FAILED non applicato, contatori non toccati.`);
      return;
    }
    await this.recipientRepo.update(attempt.recipient.id, { status: RecipientStatus.FAILED });
    await this.campaignRepo.increment({ id: attempt.recipient.campaign.id }, 'failedCount', 1);
  }
}
