import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';
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

    // Fix wave 2, fix A: guardia CANCELLED unica, valutata UNA SOLA VOLTA
    // qui, PRIMA di qualunque mutazione (stato recipient, contatori,
    // chiamata a retryRecipient()/App IO) — vale per ENTRAMBI i branch, non
    // solo POSTAL/SEND. Prima di questo fix esisteva solo dentro il branch
    // POSTAL/SEND: il branch "canale sicuro" (PEC/EMAIL/APP_IO, es.
    // dirottato INAD) forzava FAILED e aggiustava sentCount/failedCount
    // PRIMA di chiamare retryRecipient() — che poi throw BadRequestException
    // su una campagna CANCELLED, lasciando il destinatario con contatori
    // corrotti (stesso sintomo "percentuali >100%" già visto in produzione,
    // fix review finale #1) e nessun resend reale eseguito.
    // updateCampaignContent() permette deliberatamente di correggere il
    // contenuto anche su una campagna CANCELLED, ma questo non deve MAI
    // autorizzare un resend reale né una mutazione di stato/contatori.
    if (campaign?.status === CampaignStatus.CANCELLED) return 'skipped';

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

    // Guardia di idempotenza per firma contenuto: se l'ultimo resend di
    // questo destinatario riflette già il subject/body CORRENTE della
    // campagna, un secondo "Rimanda" (es. cliccato dall'altro pulsante di
    // categoria sovrapposta — "Anche App IO (parallela)" e "Dirottato su PEC
    // (INAD)" non sono mutuamente esclusivi, uno stesso destinatario può
    // comparire in entrambi) non deve rimandare una seconda volta.
    //
    // Fix wave 2, fix B: la firma vive su Recipient.lastContentResendSignature,
    // MAI su NotificationAttempt.responsePayload (dove viveva prima,
    // c897efc) — NotificationProcessor rimpiazza SEMPRE l'intero
    // responsePayload di un attempt quando il job accodato da
    // retryRecipient() completa (successo o fallimento, vedi
    // notification.processor.ts `completeSuccess()`/ramo FAILED), senza mai
    // leggere/unire il valore preesistente: una firma scritta lì verrebbe
    // silenziosamente cancellata pochi secondi dopo, rendendo la guardia
    // inefficace. Recipient non è mai toccato da quel path, la firma
    // sopravvive.
    //
    // Fix wave 3: firma computata come SHA-256 hex digest del contenuto
    // (soggetto + body JSON.stringify), produce un hash fisso 64-char anche
    // per body di lunghezza arbitraria — il limite varchar(512) della colonna
    // non può mai venire superato. Bug precedente: raw JSON.stringify su
    // body lunghi (HTML email 10000 chars, markdown App IO 10000 chars) poteva
    // facilmente superare 512, lanciando Postgres error DOPO il resend reale
    // (il messaggio era già uscito, l'errore era fuorviante).
    const contentString = JSON.stringify([
      (campaign?.channelConfig?.['subject'] as string) ?? '',
      (campaign?.channelConfig?.['body'] as string) ?? '',
    ]);
    const contentSignature = createHash('sha256').update(contentString).digest('hex');
    if (recipient?.lastContentResendSignature === contentSignature) {
      return 'skipped';
    }

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
      await this.campaignsService.retryRecipient(campaignId, recipientId);
      // Fix wave 2, fix B: firma scritta su Recipient (scalare dedicato),
      // mai su un NotificationAttempt — retryRecipient() crea un NUOVO
      // attempt che NotificationProcessor porterà a termine sovrascrivendo
      // per intero il suo responsePayload, cancellando qualunque firma
      // scritta lì (vedi commento sopra).
      await this.recipientRepo.update(recipientId, { lastContentResendSignature: contentSignature });
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
    // (La guardia CANCELLED è già stata valutata una sola volta in cima al
    // metodo, fix wave 2 fix A — non duplicata qui.)

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
    // La firma contenuto (fix wave 2 fix B) NON viene più scritta qui dentro
    // responsePayload — vive su Recipient, aggiornata subito sotto.
    await this.attemptRepo.update(lastAttempt.id, {
      responsePayload: { ...lastAttempt.responsePayload, appIo: newAppIoResult },
    });
    await this.recipientRepo.update(recipientId, { lastContentResendSignature: contentSignature });
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
