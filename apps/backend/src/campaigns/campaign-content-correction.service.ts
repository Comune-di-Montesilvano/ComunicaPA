import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { Campaign } from '../entities/campaign.entity';
import { CampaignsService } from './campaigns.service';
import { AppIoDeliveryService } from '../channels/app-io/app-io-delivery.service';
import { resolveSecondaryAppIoConfig } from '../channels/secondary-channels.util';
import { IoServicesService } from '../io-services/io-services.service';
import { APP_IO_BASE_URL } from '../channels/app-io/app-io.strategy';

const MAX_BULK_RESEND_SIZE = 500;
// Mai questi due canali: spedizione fisica/legale irreversibile — vedi spec
// task-6 (piano SDD). resendSafe non deve MAI accodare un job né chiamare la
// strategy di invio per POSTAL o SEND.
const UNSAFE_TO_RESEND: readonly string[] = ['POSTAL', 'SEND'];

export interface ResendResult {
  recipientId: string;
  result: 'resent' | 'skipped' | 'error';
  message?: string;
}

@Injectable()
export class CampaignContentCorrectionService {
  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    private readonly campaignsService: CampaignsService,
    private readonly appIoDelivery: AppIoDeliveryService,
    private readonly ioServices: IoServicesService,
  ) {}

  async resendSafe(campaignId: string, recipientId: string): Promise<'resent' | 'skipped'> {
    const lastAttempt = await this.attemptRepo.findOne({
      where: { recipientId },
      order: { attemptNumber: 'DESC' },
    });
    if (!lastAttempt) return 'skipped';

    if (!UNSAFE_TO_RESEND.includes(lastAttempt.channelType)) {
      // Canale già sicuro (PEC/EMAIL/APP_IO, es. dirottato INAD): stesso
      // pattern di updateRecipientAddressAndRetry, forza FAILED solo se
      // necessario poi riusa il retry esistente, invariato.
      const recipient = await this.recipientRepo.findOne({ where: { id: recipientId } });
      if (recipient && recipient.status !== RecipientStatus.FAILED) {
        await this.recipientRepo.update(recipientId, { status: RecipientStatus.FAILED });
      }
      await this.campaignsService.retryRecipient(campaignId, recipientId);
      return 'resent';
    }

    // POSTAL/SEND: mai un secondo invio del canale primario. Unica azione
    // sicura possibile: rimandare SOLO la co-consegna App IO, se già tentata
    // con successo — nessun percorso di questo branch chiama
    // campaignsService.retryRecipient() né accoda un job sulla coda
    // POSTAL/SEND, solo appIoDelivery.sendMessage() (canale App IO).
    const appIoPayload = lastAttempt.responsePayload?.['appIo'] as { success?: boolean } | undefined;
    if (!appIoPayload?.success) return 'skipped';

    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    const recipient = await this.recipientRepo.findOne({ where: { id: recipientId } });
    if (!campaign || !recipient) return 'skipped';

    const appIoConfig = resolveSecondaryAppIoConfig(campaign.channelConfig);
    const resolved = appIoConfig ? await this.ioServices.resolveApiKey(appIoConfig.ioServiceId) : null;
    if (!resolved) return 'skipped';

    const hasProfile = await this.appIoDelivery.checkProfile(APP_IO_BASE_URL, resolved.apiKey, recipient.codiceFiscale);
    if (!hasProfile) return 'skipped';

    const newAppIoResult = await this.appIoDelivery.sendMessage(campaign, recipient, {
      apiKey: resolved.apiKey,
      baseUrl: APP_IO_BASE_URL,
      subjectOverride: (appIoConfig as { subjectOverride?: string } | undefined)?.subjectOverride,
      bodyOverride: (appIoConfig as { bodyOverride?: string } | undefined)?.bodyOverride,
    });
    if (!newAppIoResult.success) return 'skipped';

    // Merge, mai replace: envelope/dati del canale primario già scritti restano.
    await this.attemptRepo.update(lastAttempt.id, {
      responsePayload: { ...lastAttempt.responsePayload, appIo: newAppIoResult },
    });
    return 'resent';
  }

  async resendSafeBulk(campaignId: string, recipientIds: string[]): Promise<ResendResult[]> {
    if (recipientIds.length > MAX_BULK_RESEND_SIZE) {
      throw new BadRequestException(
        `Impossibile rimandare più di ${MAX_BULK_RESEND_SIZE} destinatari in una sola richiesta (richiesti: ${recipientIds.length}).`,
      );
    }
    const results: ResendResult[] = [];
    for (const recipientId of recipientIds) {
      try {
        const result = await this.resendSafe(campaignId, recipientId);
        results.push({ recipientId, result });
      } catch (e) {
        results.push({ recipientId, result: 'error', message: e instanceof Error ? e.message : 'Errore sconosciuto' });
      }
    }
    return results;
  }
}
