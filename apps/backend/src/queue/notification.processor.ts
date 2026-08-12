import { Inject, Logger, Injectable } from '@nestjs/common';
import { WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DelayedError } from 'bullmq';
import { createHash } from 'crypto';
import type { Job } from 'bullmq';
import type { NotificationJobData, NotificationChannel } from '@comunicapa/shared-types';
import Redis from 'ioredis';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Campaign } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { THROTTLE_REDIS } from './notification-job.types';
import { CHANNEL_STRATEGIES, IChannelStrategy } from '../channels/channel.interface';
import { getEffectiveRetentionDays } from '../campaigns/retention.util';
import { AppSettingsService } from '../settings/app-settings.service';
import { MailConfigsService } from '../mail-configs/mail-configs.service';
import { IoServicesService } from '../io-services/io-services.service';
import { APP_IO_BASE_URL } from '../channels/app-io/app-io.strategy';
import { resolveSecondaryAppIoConfig } from '../channels/secondary-channels.util';
import { CampaignCompletionService } from '../campaigns/campaign-completion.service';
import { AppIoDeliveryService } from '../channels/app-io/app-io-delivery.service';
import { captureException } from '../common/sentry.util';

@Injectable()
export class NotificationProcessor extends WorkerHost {
  protected readonly logger = new Logger(NotificationProcessor.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @Inject(CHANNEL_STRATEGIES)
    private readonly strategies: Map<NotificationChannel, IChannelStrategy>,
    private readonly settings: AppSettingsService,
    @Inject(THROTTLE_REDIS)
    private readonly redis: Redis,
    private readonly mailConfigs: MailConfigsService,
    private readonly ioServices: IoServicesService,
    private readonly campaignCompletion: CampaignCompletionService,
    private readonly appIoDelivery: AppIoDeliveryService,
  ) {
    super();
  }

  async process(job: Job<NotificationJobData>, token?: string): Promise<void> {
    const { campaignId, attemptId, recipientId, channel } = job.data;
    const jobLog = (msg: string): void => {
      job.log?.(msg)?.catch((err: unknown) => this.logger.warn(`Impossibile scrivere job.log per job ${job.id}: ${err}`));
    };
    this.logger.log(`Job ${job.id}: campaign=${campaignId} recipient=${recipientId} channel=${channel}`);
    jobLog(`Job ${job.id}: campaign=${campaignId} recipient=${recipientId} channel=${channel}`);

    // relations.campaign: AttachmentService.generatePdfBuffer (usato da
    // PostalStrategy per generare il PDF da spedire) legge
    // recipient.campaign.name/.channelType — senza questa relazione carica
    // "undefined" e crasha con "Cannot read properties of undefined
    // (reading 'name')" PRIMA di qualunque chiamata al provider esterno
    // (bug reale riscontrato in test con GlobalCom: nessun invio arrivato a
    // destinazione, fallito prima). Stesso pattern già usato correttamente
    // in protocollazione.processor.ts (relations: { recipient: { campaign: true } }).
    const recipient = await this.recipientRepo.findOne({ where: { id: recipientId }, relations: { campaign: true } });
    if (!recipient) {
      throw new Error(`Recipient ${recipientId} not found`);
    }

    const campaign = await this.campaignRepo.findOne({ where: { id: campaignId } });
    if (!campaign) {
      throw new Error(`Campaign ${campaignId} not found`);
    }

    // Throttling per configurazione mittente (solo canali mail)
    if (channel === 'EMAIL' || channel === 'PEC') {
      const mailConfigId = campaign.channelConfig?.['mailConfigId'] as string | undefined;
      const resolved = await this.mailConfigs.resolveForSend(channel, mailConfigId);
      const windowMs = resolved.batchIntervalSeconds * 1000;
      const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
      const throttleKey = `comunicapa:throttle:${channel}:${resolved.configId ?? 'legacy'}:${windowStart}`;

      const count = await this.redis.incr(throttleKey);
      if (count === 1) {
        await this.redis.pexpire(throttleKey, windowMs * 2);
      }
      if (count > resolved.batchSize) {
        // Batch pieno: rimanda il job all'inizio della finestra successiva.
        // Decrementa: questo job non consuma quota in questa finestra.
        await this.redis.decr(throttleKey);
        this.logger.log(
          `Throttle ${channel} (${resolved.configId ?? 'legacy'}): batch ${resolved.batchSize} pieno, job ${job.id} rimandato`,
        );
        await job.moveToDelayed(windowStart + windowMs, token);
        throw new DelayedError();
      }
    }

    // Guardia contro redelivery BullMQ: se il worker crasha/stalla tra il "send"
    // side-effecting sul provider esterno (EMAIL/PEC/APP_IO/POSTAL — SEND non
    // passa più da questo processor, vedi ProtocollazioneSyncService/
    // SendDispatchService) e la scrittura SUCCESS su DB, il job può essere
    // ri-consegnato. Rileggiamo l'attempt fresco da DB (non dai dati del job,
    // potenzialmente stantii). Due casi distinti, gestiti diversamente:
    // 1. status già SUCCESS: il run precedente ha completato per intero (incluso
    //    l'incremento di sentCount) — non c'è nulla da fare, un secondo giro
    //    incrementerebbe i contatori due volte. Log e uscita.
    // 2. status non ancora SUCCESS ma responsePayload contiene già un
    //    identificativo esterno (scritto subito dopo che strategy.send() ha
    //    ottenuto l'ack dal provider esterno, vedi sotto): il provider ha già
    //    accettato l'invio ma il worker è morto prima di completare gli
    //    aggiornamenti finali (recipient/campaign/attempt SUCCESS). In questo
    //    caso NON richiamiamo strategy.send() (eviterebbe il doppio invio) ma
    //    completiamo comunque la coda di aggiornamenti che normalmente segue
    //    un invio riuscito, riusando il responsePayload già persistito.
    const existingAttempt = await this.attemptRepo.findOne({ where: { id: attemptId } });
    if (existingAttempt?.status === AttemptStatus.SUCCESS) {
      const msg = `Job ${job.id}: attempt ${attemptId} già SUCCESS (redelivery BullMQ) — nessuna azione, strategy.send() NON richiamato.`;
      this.logger.warn(msg);
      jobLog(msg);
      return;
    }
    const existingResponsePayload = existingAttempt?.responsePayload as Record<string, unknown> | null;
    if (existingResponsePayload?.['notificationRequestId']) {
      const msg = `Job ${job.id}: attempt ${attemptId} risulta già accettato dal provider esterno in un run precedente (redelivery BullMQ) — strategy.send() NON richiamato, completo gli aggiornamenti rimasti in sospeso.`;
      this.logger.warn(msg);
      jobLog(msg);
      await this.completeSuccess(attemptId, recipientId, campaignId, campaign, existingResponsePayload);
      return;
    }

    if (existingAttempt && existingAttempt.protocolNumber) {
      (recipient as any).protocolNumber = `${existingAttempt.protocolNumber}/${existingAttempt.protocolYear}`;
    }
    (recipient as any).attemptNumber = existingAttempt?.attemptNumber ?? 1;

    await this.attemptRepo.update(attemptId, { status: AttemptStatus.PROCESSING });

    const strategy = this.strategies.get(channel);
    if (!strategy) {
      throw new Error(`Nessuna strategy per channel ${channel}`);
    }

    const appIoConfig = resolveSecondaryAppIoConfig(campaign.channelConfig);
    const isMailChannel = channel === 'EMAIL' || channel === 'PEC' || channel === 'POSTAL';
    // Risolve la api key del servizio App IO scelto (o quello predefinito) solo se serve:
    // niente più api key in chiaro dentro channelConfig (cifrata lato server per servizio).
    const appIoResolved = appIoConfig && isMailChannel
      ? await this.ioServices.resolveApiKey(appIoConfig.ioServiceId)
      : null;
    if (appIoConfig && isMailChannel && !appIoResolved) {
      this.logger.warn(
        `Co-delivery App IO configurata per la campagna ${campaignId} (ioServiceId="${appIoConfig.ioServiceId ?? ''}") ma resolveApiKey non ha trovato un servizio valido con api key primaria impostata: App IO NON verrà tentato per il destinatario ${recipientId}. Verifica che il servizio esista e abbia un'api key configurata in Impostazioni → App IO.`,
      );
    }
    // Retrocompat: config appIo presente senza mode = parallel
    const configuredAppIoMode: 'none' | 'parallel' | 'exclusive' =
      appIoResolved ? (appIoConfig!.mode ?? 'parallel') : 'none';
    // INAD è fonte di verità assoluta sul domicilio digitale: per un
    // destinatario dirottato (recipient.inadCheck.diverted) il canale
    // primario (già impostato su PEC in attempt.channelType) deve arrivare
    // sempre, non può essere saltato da un'esclusiva App IO — declassata a
    // "parallela" solo per QUESTO destinatario, non per l'intera campagna:
    // se il cittadino ha anche App IO lo riceve in aggiunta, mai al posto di.
    const appIoMode: 'none' | 'parallel' | 'exclusive' =
      configuredAppIoMode === 'exclusive' && recipient.inadCheck?.diverted ? 'parallel' : configuredAppIoMode;

    // Gate anti-duplicato: retryRecipient() crea un NUOVO attempt con un
    // NUOVO jobId per ogni retry (es. correzione indirizzo POSTAL dopo un
    // errore GlobalCom) — job.attemptsMade riparte da 0 su quel job, quindi
    // senza questo controllo la co-consegna App IO (gated solo su
    // job.attemptsMade===0) verrebbe rispedita al cittadino ad ogni retry
    // del canale primario, anche quando il contenuto non è cambiato. Stessa
    // firma SHA-256 di CampaignContentCorrectionService.resendSafe() (stesso
    // campo Recipient.lastContentResendSignature, mai su
    // NotificationAttempt.responsePayload — un retry sovrascrive per intero
    // il responsePayload del nuovo attempt, vedi commento lì) — se il retry
    // è successivo al primo tentativo (attemptNumber>1) e la firma coincide
    // con l'ultimo invio App IO riuscito, si salta il resend.
    const appIoContentSignature = createHash('sha256')
      .update(JSON.stringify([
        (campaign.channelConfig?.['subject'] as string) ?? '',
        (campaign.channelConfig?.['body'] as string) ?? '',
      ]))
      .digest('hex');
    const isPrimaryRetryAttempt = ((recipient as any).attemptNumber ?? 1) > 1;
    const skipAppIoUnchanged =
      isPrimaryRetryAttempt && recipient.lastContentResendSignature === appIoContentSignature;

    const responsePayload: Record<string, any> = {};
    let appIoLinkDelivered = false;
    let primaryResult: { messageId?: string; responsePayload?: Record<string, unknown> } | undefined;
    let primaryError: Error | undefined;
    let skipPrimary = false;

    // Modalità ESCLUSIVA: se il destinatario ha App IO, si invia SOLO lì.
    if (appIoMode === 'exclusive' && isMailChannel && job.attemptsMade === 0 && !skipAppIoUnchanged) {
      const hasAppIo = await this.appIoDelivery.checkProfile(
        APP_IO_BASE_URL, appIoResolved!.apiKey, recipient.codiceFiscale, jobLog,
      );
      if (hasAppIo) {
        const appIoResult = await this.appIoDelivery.sendMessage(campaign, recipient, {
          apiKey: appIoResolved!.apiKey,
          baseUrl: APP_IO_BASE_URL,
          subjectOverride: (appIoConfig as { subjectOverride?: string } | undefined)?.subjectOverride,
          bodyOverride: (appIoConfig as { bodyOverride?: string } | undefined)?.bodyOverride,
        }, jobLog);
        responsePayload.appIo = appIoResult;
        if (appIoResult.success) {
          skipPrimary = true;
          appIoLinkDelivered = true;
          responsePayload.messageId = appIoResult.messageId;
          responsePayload.deliveredVia = 'APP_IO';
          this.logger.log(`Consegna esclusiva App IO per CF ${recipient.codiceFiscale}: canale ${channel} saltato`);
          jobLog(`Consegna esclusiva App IO per CF ${recipient.codiceFiscale}: canale ${channel} saltato`);
          await this.recipientRepo.update(recipientId, { lastContentResendSignature: appIoContentSignature });
        }
        // App IO fallita ⇒ si prosegue col canale primario (fallback)
      }
    } else if (appIoMode === 'exclusive' && isMailChannel && job.attemptsMade === 0 && skipAppIoUnchanged) {
      jobLog(`App IO esclusiva saltata per CF ${recipient.codiceFiscale}: contenuto invariato dall'ultimo invio riuscito (retry attempt ${(recipient as any).attemptNumber}).`);
    }

    // 1. Invio canale primario (saltato solo in esclusiva riuscita)
    if (!skipPrimary) {
      try {
        primaryResult = await strategy.send(recipient, campaign, jobLog, attemptId, job.attemptsMade);
      } catch (err: any) {
        primaryError = err instanceof Error ? err : new Error(String(err));
        jobLog(`Errore canale primario ${channel}: ${primaryError.message}`);
      }
      Object.assign(responsePayload, primaryResult?.responsePayload || {});
      responsePayload.messageId = primaryResult?.messageId;

      // Scrittura immediata (subito dopo l'ack del provider esterno, PRIMA di
      // retention/App IO co-delivery che seguono): se il worker crasha in
      // questa finestra, la guardia redelivery in testa a process() vede già
      // notificationRequestId su DB e non richiama strategy.send() una seconda
      // volta — senza questa scrittura, un crash qui lascerebbe l'attempt in
      // PROCESSING con responsePayload vuoto, invisibile alla guardia.
      if (primaryResult) {
        await this.attemptRepo.update(attemptId, { responsePayload });
        if (channel === 'POSTAL' && primaryResult.messageId) {
          const statoIniziale = (primaryResult.responsePayload as Record<string, unknown> | undefined)?.['stato'] as string | undefined;
          await this.attemptRepo.update(attemptId, {
            postalTrackingId: primaryResult.messageId,
            ...(statoIniziale ? {
              postalStatus: statoIniziale,
              postalStatusHistory: [{ stato: statoIniziale, rilevatoIl: new Date().toISOString() }],
            } : {}),
          });
        }
      }

      // 2. Co-delivery PARALLELA (comportamento attuale, solo primo tentativo
      // o retry con contenuto cambiato — vedi skipAppIoUnchanged sopra)
      if (appIoMode === 'parallel' && isMailChannel && job.attemptsMade === 0 && !skipAppIoUnchanged) {
        const hasAppIo = await this.appIoDelivery.checkProfile(
          APP_IO_BASE_URL, appIoResolved!.apiKey, recipient.codiceFiscale, jobLog,
        );
        if (hasAppIo) {
          this.logger.log(`Invio App IO parallelo per CF: ${recipient.codiceFiscale}`);
          jobLog(`Invio App IO parallelo per CF: ${recipient.codiceFiscale}`);
          const appIoResult = await this.appIoDelivery.sendMessage(campaign, recipient, {
          apiKey: appIoResolved!.apiKey,
          baseUrl: APP_IO_BASE_URL,
          subjectOverride: (appIoConfig as { subjectOverride?: string } | undefined)?.subjectOverride,
          bodyOverride: (appIoConfig as { bodyOverride?: string } | undefined)?.bodyOverride,
        }, jobLog, channel);
          responsePayload.appIo = appIoResult;
          if (appIoResult.success) {
            appIoLinkDelivered = true;
            await this.recipientRepo.update(recipientId, { lastContentResendSignature: appIoContentSignature });
          }
        }
      } else if (appIoMode === 'parallel' && isMailChannel && job.attemptsMade === 0 && skipAppIoUnchanged) {
        jobLog(`App IO parallela saltata per CF ${recipient.codiceFiscale}: contenuto invariato dall'ultimo invio riuscito (retry attempt ${(recipient as any).attemptNumber}).`);
      }
    }

    // 3. Esito canale primario determina lo stato del tentativo/destinatario
    if (primaryError) {
      captureException(primaryError, { attemptId, channel, recipientId: recipient.id });
      await this.attemptRepo.update(attemptId, {
        status: AttemptStatus.FAILED,
        errorMessage: primaryError.message,
        responsePayload,
      });
      // Anche se il canale primario fallisce, se App IO ha consegnato un link firmato valido
      // il cittadino può scaricare l'allegato: la sua vita deve essere limitata dalla retention,
      // quindi impostiamo comunque attachmentExpiresAt (altrimenti il cron non lo cancellerà mai).
      const failedUpdate: { status: RecipientStatus; attachmentExpiresAt?: Date } = {
        status: RecipientStatus.FAILED,
      };
      if (appIoLinkDelivered) {
        const retentionMaxDaysOnFail = await this.settings.get<number>('retention.maxDays');
        const retentionDaysOnFail = getEffectiveRetentionDays(campaign, retentionMaxDaysOnFail);
        failedUpdate.attachmentExpiresAt = new Date(Date.now() + retentionDaysOnFail * 86400 * 1000);
      }
      await this.recipientRepo.update(recipientId, failedUpdate);
      await this.campaignRepo.increment({ id: campaignId }, 'failedCount', 1);
      await this.campaignCompletion.checkAndComplete(campaignId);
      throw primaryError;
    }

    await this.completeSuccess(attemptId, recipientId, campaignId, campaign, responsePayload);
  }

  /**
   * Coda di aggiornamenti che segue un invio primario riuscito: marca l'attempt
   * SUCCESS, il destinatario SENT (con scadenza allegato da retention), incrementa
   * sentCount e verifica il completamento campagna. Estratto in un metodo a parte
   * perché va rieseguito anche dalla guardia di redelivery in process() quando un
   * run precedente ha ottenuto l'ack dal provider esterno ma non ha completato
   * questi aggiornamenti prima di un crash/stall del worker (vedi commento in process()).
   */
  private async completeSuccess(
    attemptId: string,
    recipientId: string,
    campaignId: string,
    campaign: Campaign,
    responsePayload: Record<string, any>,
  ): Promise<void> {
    const retentionMaxDaysForExpiry = await this.settings.get<number>('retention.maxDays');
    const retentionDaysForExpiry = getEffectiveRetentionDays(campaign, retentionMaxDaysForExpiry);
    const attachmentExpiresAt = new Date(Date.now() + retentionDaysForExpiry * 86400 * 1000);

    await this.attemptRepo.update(attemptId, {
      status: AttemptStatus.SUCCESS,
      sentAt: new Date(),
      responsePayload,
    });
    await this.recipientRepo.update(recipientId, {
      status: RecipientStatus.SENT,
      attachmentExpiresAt,
    });
    await this.campaignRepo.increment({ id: campaignId }, 'sentCount', 1);
    await this.campaignCompletion.checkAndComplete(campaignId);
  }

}
