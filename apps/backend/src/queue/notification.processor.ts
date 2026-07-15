import { Inject, Logger, Injectable } from '@nestjs/common';
import { WorkerHost } from '@nestjs/bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DelayedError } from 'bullmq';
import type { Job } from 'bullmq';
import type { NotificationJobData, NotificationChannel } from '@comunicapa/shared-types';
import Redis from 'ioredis';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Campaign } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { THROTTLE_REDIS } from './notification-job.types';
import { CHANNEL_STRATEGIES, IChannelStrategy } from '../channels/channel.interface';
import { processTemplate } from '../channels/template.helper';
import { resolveAttachmentsConfig } from '../attachments/attachment.service';
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../config/configuration';
import { getEffectiveRetentionDays } from '../campaigns/retention.util';
import { AppSettingsService } from '../settings/app-settings.service';
import { MailConfigsService } from '../mail-configs/mail-configs.service';
import { IoServicesService } from '../io-services/io-services.service';
import { APP_IO_BASE_URL } from '../channels/app-io/app-io.strategy';
import { resolveSecondaryAppIoConfig } from '../channels/secondary-channels.util';
import { resolvePaymentData } from '../channels/payment-config.util';
import { CampaignCompletionService } from '../campaigns/campaign-completion.service';

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
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly settings: AppSettingsService,
    @Inject(THROTTLE_REDIS)
    private readonly redis: Redis,
    private readonly mailConfigs: MailConfigsService,
    private readonly ioServices: IoServicesService,
    private readonly campaignCompletion: CampaignCompletionService,
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
    const appIoMode: 'none' | 'parallel' | 'exclusive' =
      appIoResolved ? (appIoConfig!.mode ?? 'parallel') : 'none';

    const responsePayload: Record<string, any> = {};
    let appIoLinkDelivered = false;
    let primaryResult: { messageId?: string; responsePayload?: Record<string, unknown> } | undefined;
    let primaryError: Error | undefined;
    let skipPrimary = false;

    // Modalità ESCLUSIVA: se il destinatario ha App IO, si invia SOLO lì.
    if (appIoMode === 'exclusive' && isMailChannel && job.attemptsMade === 0) {
      const hasAppIo = await this.checkAppIoProfile(
        APP_IO_BASE_URL, appIoResolved!.apiKey, recipient.codiceFiscale, jobLog,
      );
      if (hasAppIo) {
        const appIoResult = await this.sendAppIoMessage(campaign, recipient, {
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
        }
        // App IO fallita ⇒ si prosegue col canale primario (fallback)
      }
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
          await this.attemptRepo.update(attemptId, { postalTrackingId: primaryResult.messageId });
        }
      }

      // 2. Co-delivery PARALLELA (comportamento attuale, solo primo tentativo)
      if (appIoMode === 'parallel' && isMailChannel && job.attemptsMade === 0) {
        const hasAppIo = await this.checkAppIoProfile(
          APP_IO_BASE_URL, appIoResolved!.apiKey, recipient.codiceFiscale, jobLog,
        );
        if (hasAppIo) {
          this.logger.log(`Invio App IO parallelo per CF: ${recipient.codiceFiscale}`);
          jobLog(`Invio App IO parallelo per CF: ${recipient.codiceFiscale}`);
          const appIoResult = await this.sendAppIoMessage(campaign, recipient, {
          apiKey: appIoResolved!.apiKey,
          baseUrl: APP_IO_BASE_URL,
          subjectOverride: (appIoConfig as { subjectOverride?: string } | undefined)?.subjectOverride,
          bodyOverride: (appIoConfig as { bodyOverride?: string } | undefined)?.bodyOverride,
        }, jobLog);
          responsePayload.appIo = appIoResult;
          if (appIoResult.success) appIoLinkDelivered = true;
        }
      }
    }

    // 3. Esito canale primario determina lo stato del tentativo/destinatario
    if (primaryError) {
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

  private async checkAppIoProfile(
    baseUrl: string,
    apiKey: string,
    fiscalCode: string,
    onLog?: (msg: string) => void,
  ): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl}/api/v1/profiles/${fiscalCode}`, {
        method: 'GET',
        headers: {
          'Ocp-Apim-Subscription-Key': apiKey,
        },
      });
      if (!res.ok) {
        // 404 = cittadino non ha mai attivato App IO (esito atteso, non un
        // errore); altri status possono indicare un problema reale (CF
        // malformato, api key non valida, servizio App IO giù, ecc.) —
        // logghiamo comunque, col body di PagoPA quando c'è, per rendere
        // distinguibili i due casi quando la co-consegna non parte.
        const detail = res.status === 404 ? '' : await res.text().catch(() => '');
        const msg = `Profilo App IO non disponibile per CF ${fiscalCode}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
        this.logger.debug(msg);
        onLog?.(msg);
        return false;
      }
      const data = (await res.json()) as { sender_allowed: boolean };
      if (!data?.sender_allowed) {
        const msg = `Cittadino CF ${fiscalCode} ha disabilitato i messaggi da questo servizio App IO`;
        this.logger.debug(msg);
        onLog?.(msg);
      }
      return !!data?.sender_allowed;
    } catch (err: any) {
      const msg = `Verifica profilo App IO fallita per CF ${fiscalCode}: ${err?.message ?? err}`;
      this.logger.warn(msg);
      onLog?.(msg);
      return false;
    }
  }

  private async sendAppIoMessage(
    campaign: Campaign,
    recipient: Recipient,
    appIoConfig: { apiKey: string; baseUrl: string; subjectOverride?: string; bodyOverride?: string },
    onLog?: (msg: string) => void,
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      const publicApiUrl = await this.settings.get<string>('system.publicUrl');
      const downloadLinkSecret = this.config.get('downloadLink.secret', { infer: true });
      const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
      const retentionDays = getEffectiveRetentionDays(campaign, retentionMaxDays);
      const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;

      const attachmentLabels = resolveAttachmentsConfig(campaign.channelConfig).map((a) => a.label);
      const processedSubject = processTemplate(
        appIoConfig.subjectOverride || (campaign.channelConfig?.['subject'] as string) || campaign.name,
        recipient,
        publicApiUrl,
        downloadLinkSecret,
        expiresAtUnix,
        attachmentLabels,
        'html',
        'APP_IO',
      );
      const processedMarkdown = processTemplate(
        appIoConfig.bodyOverride || (campaign.channelConfig?.['body'] as string) || '',
        recipient,
        publicApiUrl,
        downloadLinkSecret,
        expiresAtUnix,
        attachmentLabels,
        'markdown',
        'APP_IO',
      );

      const contentPayload: Record<string, any> = {
        subject: processedSubject,
        markdown: processedMarkdown,
      };

      const paymentConfig = campaign.channelConfig?.['paymentConfig'] as Record<string, any> | undefined;
      const resolvedPayment = resolvePaymentData(recipient, paymentConfig);
      if (resolvedPayment?.noticeCode && resolvedPayment.amountCents != null) {
        const paymentData: Record<string, any> = {
          amount: resolvedPayment.amountCents,
          notice_number: resolvedPayment.noticeCode,
          invalid_after_due_date: true,
        };
        if (resolvedPayment.creditorTaxId) {
          paymentData.payee = { fiscal_code: resolvedPayment.creditorTaxId };
        }
        contentPayload.payment_data = paymentData;
      }
      if (resolvedPayment?.dueDateIso) {
        contentPayload.due_date = resolvedPayment.dueDateIso;
      }

      onLog?.(`Invio App IO (co-delivery) a CF ${recipient.codiceFiscale}: markdown length=${processedMarkdown.length}`);
      const appIoRes = await fetch(`${appIoConfig.baseUrl}/api/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': appIoConfig.apiKey },
        body: JSON.stringify({
          fiscal_code: recipient.codiceFiscale,
          content: contentPayload,
        }),
      });
      onLog?.(`Risposta App IO (co-delivery) per CF ${recipient.codiceFiscale}: HTTP ${appIoRes.status}`);

      if (!appIoRes.ok) {
        const detail = await appIoRes.text().catch(() => '');
        const error = `App IO status: ${appIoRes.status}${detail ? ` — ${detail}` : ''}`;
        onLog?.(error);
        return { success: false, error };
      }
      const appIoData = (await appIoRes.json()) as { id: string };
      return { success: true, messageId: appIoData.id };
    } catch (err: any) {
      onLog?.(`Eccezione invio App IO (co-delivery) per CF ${recipient.codiceFiscale}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }
}
