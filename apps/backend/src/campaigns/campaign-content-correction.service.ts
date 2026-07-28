import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { CampaignsService } from './campaigns.service';
import { AppIoDeliveryService } from '../channels/app-io/app-io-delivery.service';
import { resolveSecondaryAppIoConfig } from '../channels/secondary-channels.util';
import { IoServicesService } from '../io-services/io-services.service';
import { APP_IO_BASE_URL } from '../channels/app-io/app-io.strategy';

// A differenza di retryRecipientsBulk (solo lavoro DB per destinatario,
// cap 500 sicuro), il branch App IO qui sotto fa fino a DUE chiamate HTTP
// esterne sequenziali per destinatario (checkProfile + sendMessage verso
// PagoPA) — un cap più basso riduce il rischio di timeout del reverse
// proxy davanti al backend in produzione su un batch grande (fix review
// finale #5, vedi CLAUDE.md sezione bulk/reverse proxy).
const MAX_BULK_RESEND_SIZE = 100;
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

    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });

    // Guardia di idempotenza per firma contenuto: se l'ultimo tentativo di
    // questo destinatario riflette già il subject/body CORRENTE della
    // campagna, un secondo "Rimanda" (es. cliccato dall'altro pulsante di
    // categoria sovrapposta — "Anche App IO (parallela)" e "Dirottato su PEC
    // (INAD)" non sono mutuamente esclusivi, uno stesso destinatario può
    // comparire in entrambi) non deve rimandare una seconda volta.
    const contentSignature = JSON.stringify([
      (campaign?.channelConfig?.['subject'] as string) ?? '',
      (campaign?.channelConfig?.['body'] as string) ?? '',
    ]);
    if (lastAttempt.responsePayload?.['contentSignature'] === contentSignature) {
      return 'skipped';
    }

    // Ownership: recipientId deve appartenere davvero a questa campagna.
    // Il branch sicuro sotto è protetto implicitamente perché
    // retryRecipient() lo verifica da solo (NotFoundException se
    // recipient.campaignId !== campaignId) — ma il branch POSTAL/SEND non
    // passa mai da retryRecipient(), quindi senza questo controllo un
    // recipientId di un'ALTRA campagna potrebbe essere rimandato con il
    // contenuto/config App IO della campagna sbagliata (fix review finale
    // #3). Controllo fatto una volta qui, copre entrambi i branch.
    const recipient = await this.recipientRepo.findOne({ where: { id: recipientId } });
    if (recipient && recipient.campaignId !== campaignId) return 'skipped';

    if (!UNSAFE_TO_RESEND.includes(lastAttempt.channelType)) {
      // Canale già sicuro (PEC/EMAIL/APP_IO, es. dirottato INAD): stesso
      // pattern di updateRecipientAddressAndRetry (campaigns.service.ts) —
      // forza FAILED solo se necessario E aggiorna sentCount/failedCount
      // PRIMA di chiamare retryRecipient(), che decrementa failedCount di 1
      // assumendo il destinatario fosse GIÀ contato come fallito. Senza
      // questo aggiornamento un destinatario forzato da SENT a FAILED non
      // veniva mai scontato da sentCount, e retryRecipient() decrementava
      // comunque failedCount (mai incrementato per lui) portandolo a -1 —
      // la causa della drift sentCount/failedCount vista in produzione
      // (fix review finale #1, torta "Esito Invio" con percentuali > 100%).
      if (recipient && recipient.status !== RecipientStatus.FAILED) {
        const wasSent = recipient.status === RecipientStatus.SENT;
        await this.recipientRepo.update(recipientId, { status: RecipientStatus.FAILED });
        if (wasSent) {
          await this.campaignRepo.decrement({ id: campaignId }, 'sentCount', 1);
        }
        await this.campaignRepo.increment({ id: campaignId }, 'failedCount', 1);
      }
      const result = await this.campaignsService.retryRecipient(campaignId, recipientId);
      // Il retry crea un NUOVO NotificationAttempt (lastAttempt è ormai
      // superato) — la firma va apposta su quello nuovo, non su lastAttempt.
      await this.attemptRepo.update(result.attemptId, { responsePayload: { contentSignature } });
      return 'resent';
    }

    // POSTAL/SEND: mai un secondo invio del canale primario. Unica azione
    // sicura possibile: rimandare SOLO la co-consegna App IO, se già tentata
    // con successo — nessun percorso di questo branch chiama
    // campaignsService.retryRecipient() né accoda un job sulla coda
    // POSTAL/SEND, solo appIoDelivery.sendMessage() (canale App IO).
    const appIoPayload = lastAttempt.responsePayload?.['appIo'] as { success?: boolean } | undefined;
    if (!appIoPayload?.success) return 'skipped';

    if (!campaign || !recipient) return 'skipped';

    // Campagna già annullata dall'operatore: updateCampaignContent (task 5)
    // permette deliberatamente di correggere il contenuto anche su una
    // campagna CANCELLED, ma questo non deve autorizzare un invio App IO
    // REALE al cittadino — stessa guardia già presente in retryRecipient()
    // per il branch sicuro sopra (fix review finale #2). Ritorna 'skipped'
    // (non throw): resendSafeBulk chiama questo metodo in loop per-recipient,
    // un'eccezione qui verrebbe riclassificata 'error' invece di 'skipped',
    // meno accurato per un motivo puramente di stato campagna, non un guasto.
    if (campaign.status === CampaignStatus.CANCELLED) return 'skipped';

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
      responsePayload: { ...lastAttempt.responsePayload, appIo: newAppIoResult, contentSignature },
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
