import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { parse } from 'csv-parse';
import * as fs from 'fs';
import { join } from 'path';
import { extractZipWithYauzl } from './zip-extract.util';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../config/configuration';
import { AppSettingsService } from '../settings/app-settings.service';
import { processTemplate, wrapInHtmlLayout } from '../channels/template.helper';
import { getEffectiveRetentionDays } from './retention.util';
import { getUploadsDir } from '../attachments/attachment-paths';
import { resolveAttachmentsConfig, resolveAttachmentLabel, resolveCustomAttachmentFilename } from '../attachments/attachment.service';
import { resolveSubjectTemplate } from '../channels/subject-mapping.util';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { NOTIFICATION_JOB_SEND } from '../queue/notification-job.types';
import { NotificationQueuesService } from '../queue/notification-queues.service';
import { resolveSecondaryAppIoConfig } from '../channels/secondary-channels.util';
import type { CreateCampaignDto } from './dto/create-campaign.dto';
import type { UpdateCampaignDto } from './dto/update-campaign.dto';
import type { CampaignStatsDto, RecipientStatDto, RecipientStatsPageDto, ChannelBreakdownDto, DownloadCombinationDto, DownloadCombinationStatsDto, FailureRowDto, FailureGroupDto, RetryBulkResultDto, DownloadReportRowDto, SendStatusBreakdownDto, SendReportDto, SendReportRowDto, PostalStatusBreakdownDto, PostalReportDto, PostalReportRowDto } from './dto/campaign-stats.dto';
import type { GlobalStatsDto, NeverDownloadedRowDto } from './dto/global-stats.dto';
import { mergeMonthlyTrend, computeDownloadPercentage, buildDateRangeWhere } from './global-stats.util';
import type { PreviewMessageDto, PreviewMessageResult } from './dto/preview-message.dto';
import type { NotificationChannel } from '@comunicapa/shared-types';
import { InadService } from '../channels/inad/inad.service';

const MAX_BULK_RETRY_SIZE = 500;
const INAD_BULK_THRESHOLD = 100;

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(DownloadEvent)
    private readonly downloadEventRepo: Repository<DownloadEvent>,
    private readonly notificationQueues: NotificationQueuesService,
    private readonly settings: AppSettingsService,
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly inadService: InadService,
  ) {}

  findAll(): Promise<Campaign[]> {
    return this.campaignRepo.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<Campaign> {
    const campaign = await this.campaignRepo.findOneBy({ id });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);
    return campaign;
  }

  async updateDraft(id: string, dto: UpdateCampaignDto): Promise<Campaign> {
    const campaign = await this.campaignRepo.findOneBy({ id });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);
    if (campaign.status !== CampaignStatus.DRAFT) {
      throw new BadRequestException('Solo le campagne in bozza possono essere modificate');
    }
    if (dto.name !== undefined) campaign.name = dto.name;
    if (dto.description !== undefined) campaign.description = dto.description;
    if (dto.channelConfig !== undefined) campaign.channelConfig = dto.channelConfig;
    return this.campaignRepo.save(campaign);
  }

  async getDuplicateSource(id: string): Promise<{
    name: string;
    description: string | null;
    channelType: Campaign['channelType'];
    channelConfig: Record<string, unknown>;
  }> {
    const campaign = await this.campaignRepo.findOneBy({ id });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);
    return {
      name: campaign.name,
      description: campaign.description,
      channelType: campaign.channelType,
      channelConfig: campaign.channelConfig,
    };
  }

  /**
   * Rende oggetto+corpo di un messaggio usando lo stesso motore di template
   * (processTemplate/wrapInHtmlLayout) usato realmente in invio, per un
   * destinatario transitorio (mai persistito: id casuale, usato solo per
   * firmare il link di download nello stesso formato di produzione — il
   * link non risolve realmente perché nessun allegato è associato a
   * quell'id in DB). Usata dal wizard per l'anteprima live.
   */
  async previewMessage(dto: PreviewMessageDto): Promise<PreviewMessageResult> {
    const previewRecipient = {
      id: randomUUID(),
      codiceFiscale: dto.recipient.codiceFiscale,
      fullName: dto.recipient.fullName ?? null,
      email: dto.recipient.email ?? null,
      pec: dto.recipient.pec ?? null,
      extraData: dto.recipient.extraData ?? {},
      protocolNumber: dto.recipient.protocolNumber ?? null,
    } as unknown as Recipient;

    const attachmentLabels = (dto.attachments ?? []).map((a) => resolveAttachmentLabel(a, previewRecipient));
    return this.renderMessage(dto.channelType, dto.subject, dto.body, attachmentLabels, previewRecipient, dto.format);
  }

  /**
   * Rende oggetto+corpo di un destinatario REALE (già persistito), usata sia dal
   * dettaglio notifica del backoffice sia dal portale cittadino (stesso motore di
   * `previewMessage`, nessuna duplicazione di logica) — mostra esattamente ciò che
   * è stato realmente inviato.
   *
   * `preview` distingue i due casi: true = link marcato come anteprima backoffice
   * (un click dell'operatore non conta come download), false = link "vero" del
   * portale cittadino (il click del cittadino DEVE continuare a contare — non
   * passare mai true per il rendering mostrato al cittadino stesso).
   */
  async renderMessageForRecipient(recipientId: string, linkChannelTag?: string, preview = true): Promise<PreviewMessageResult> {
    const recipient = await this.recipientRepo.findOne({ where: { id: recipientId }, relations: ['campaign'] });
    if (!recipient) throw new NotFoundException(`Recipient ${recipientId} not found`);

    const campaign = recipient.campaign;
    const subjectTemplate = resolveSubjectTemplate(campaign, recipient);
    const bodyTemplate = (campaign.channelConfig?.['body'] as string) || '';
    const attachmentLabels = resolveAttachmentsConfig(campaign.channelConfig).map((a) => resolveAttachmentLabel(a, recipient));

    return this.renderMessage(campaign.channelType, subjectTemplate, bodyTemplate, attachmentLabels, recipient, undefined, linkChannelTag, preview);
  }

  /**
   * Rende il messaggio App IO di co-consegna realmente configurato per un
   * destinatario (subjectOverride/bodyOverride di `secondaryChannels`), non
   * il body del canale primario — usato dal dettaglio notifica per mostrare
   * cosa è arrivato su App IO quando la co-consegna è andata a buon fine,
   * distinto dal contenuto (lettera POSTAL, PEC, ecc.) del canale primario.
   */
  async renderAppIoCoDeliveryPreview(recipientId: string): Promise<PreviewMessageResult | null> {
    const recipient = await this.recipientRepo.findOne({ where: { id: recipientId }, relations: ['campaign'] });
    if (!recipient) throw new NotFoundException(`Recipient ${recipientId} not found`);

    const campaign = recipient.campaign;
    const appIoConfig = resolveSecondaryAppIoConfig(campaign.channelConfig) as
      | { subjectOverride?: string; bodyOverride?: string }
      | undefined;
    if (!appIoConfig) return null;

    const subjectTemplate = appIoConfig.subjectOverride || (campaign.channelConfig?.['subject'] as string) || campaign.name;
    const bodyTemplate = appIoConfig.bodyOverride || (campaign.channelConfig?.['body'] as string) || '';
    const attachmentLabels = resolveAttachmentsConfig(campaign.channelConfig).map((a) => resolveAttachmentLabel(a, recipient));

    return this.renderMessage('APP_IO', subjectTemplate, bodyTemplate, attachmentLabels, recipient, 'markdown', undefined, true);
  }

  private async renderMessage(
    channelType: string,
    subjectTemplate: string,
    bodyTemplate: string,
    attachmentLabels: string[],
    recipientLike: Recipient,
    format?: 'html' | 'markdown',
    linkChannelTag?: string,
    preview = false,
  ): Promise<PreviewMessageResult> {
    const brandName = (await this.settings.get<string>('brand.name')) || 'Comune di Montesilvano';
    const publicApiUrl = await this.settings.get<string>('system.publicUrl');
    const downloadLinkSecret = this.config.get('downloadLink.secret', { infer: true });
    const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
    const retentionDays = getEffectiveRetentionDays({ retentionDays: null }, retentionMaxDays);
    const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;
    const resolvedFormat: 'html' | 'markdown' = format ?? (channelType === 'APP_IO' ? 'markdown' : 'html');
    const linkTag = linkChannelTag ?? channelType;

    const subject = processTemplate(subjectTemplate, recipientLike, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, resolvedFormat, linkTag, preview);
    const body = processTemplate(bodyTemplate, recipientLike, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, resolvedFormat, linkTag, preview);

    if (resolvedFormat === 'markdown') {
      return { subject, bodyMarkdown: body };
    }

    const brandLogo = await this.settings.get<string>('brand.logo');
    const logoUrl = brandLogo ? (/^https?:\/\//i.test(brandLogo) ? brandLogo : `${publicApiUrl}/branding/logo`) : null;
    const portalUrl = (await this.settings.get<string>('system.citizenPublicUrl')) || null;
    const bodyHtml = wrapInHtmlLayout(body, brandName, { logoUrl, portalUrl });

    return { subject, bodyHtml };
  }

  create(dto: CreateCampaignDto, createdBy: string): Promise<Campaign> {
    const campaign = this.campaignRepo.create({
      name: dto.name,
      description: dto.description ?? null,
      channelType: dto.channelType,
      channelConfig: dto.channelConfig ?? {},
      status: CampaignStatus.DRAFT,
      createdBy,
    });
    return this.campaignRepo.save(campaign);
  }

  async uploadCsv(
    campaignId: string,
    filePath: string,
  ): Promise<{ imported: number; campaignId: string; blocked?: boolean; message?: string }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) {
      await unlink(filePath).catch(() => undefined);
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }
    if (campaign.status !== CampaignStatus.DRAFT) {
      await unlink(filePath).catch(() => undefined);
      throw new BadRequestException('Campaign must be in draft status to upload recipients');
    }

    let imported = 0;
    const batch: Partial<Recipient>[] = [];
    const BATCH_SIZE = 200;

    const parser = createReadStream(filePath).pipe(
      parse({ columns: true, skip_empty_lines: true, trim: true }),
    );

    try {
      // Svuota i destinatari esistenti per evitare duplicati in caso di ri-upload o modifica bozza
      await this.recipientRepo.delete({ campaignId });
      await this.campaignRepo.update({ id: campaignId }, { totalRecipients: 0 });

      for await (const row of parser as AsyncIterable<Record<string, string>>) {
        const cf = String(row['codice_fiscale'] ?? '').toUpperCase().trim();
        if (!cf) continue;

        const extraData: Record<string, unknown> = { ...row };
        delete extraData['codice_fiscale'];
        delete extraData['email'];
        delete extraData['pec'];
        delete extraData['full_name'];

        batch.push({
          campaignId,
          codiceFiscale: cf,
          email: row['email']?.trim() || null,
          pec: row['pec']?.trim() || null,
          fullName: row['full_name']?.trim() || null,
          extraData,
          status: RecipientStatus.PENDING,
        });

        if (batch.length >= BATCH_SIZE) {
          await this.recipientRepo.save(batch.splice(0));
          imported += BATCH_SIZE;
        }
      }

      if (batch.length > 0) {
        await this.recipientRepo.save(batch);
        imported += batch.length;
      }

      await this.campaignRepo.increment({ id: campaignId }, 'totalRecipients', imported);
    } catch (err: any) {
      // Risposta 200 con blocked=true (non un errore HTTP non-2xx): il reverse
      // proxy di produzione intercetta le risposte non-2xx e ne sostituisce il
      // body con una pagina HTML propria, rendendo illeggibile il messaggio
      // lato frontend — stesso pattern già usato in launch().
      this.logger.error(`Import CSV fallito per campagna ${campaignId} (${imported} destinatari già importati prima dell'errore): ${err?.message ?? err}`);
      return {
        imported,
        campaignId,
        blocked: true,
        message: `Import interrotto dopo ${imported} destinatari: ${err?.message ?? 'errore sconosciuto'}`,
      };
    } finally {
      await unlink(filePath).catch(() => undefined);
    }

    return { imported, campaignId };
  }

  async launch(
    campaignId: string,
  ): Promise<{ launched: number; campaignId: string; blocked?: boolean; message?: string }> {
    const launchResult = await this.campaignRepo
      .createQueryBuilder()
      .update()
      .set({ status: CampaignStatus.QUEUED })
      .where('id = :id AND status = :draft', { id: campaignId, draft: CampaignStatus.DRAFT })
      .execute();

    if (launchResult.affected === 0) {
      const exists = await this.campaignRepo.existsBy({ id: campaignId });
      if (!exists) throw new NotFoundException(`Campaign ${campaignId} not found`);
      throw new BadRequestException('Only draft campaigns can be launched');
    }

    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    // SEND richiede sempre protocollazione preventiva (ProtocollazioneSyncService
    // pesca solo attempt con channelConfig.protocolla=true; SendDispatchService
    // pesca solo attempt già protocollati) — se il wizard non l'ha impostato,
    // una campagna SEND resterebbe QUEUED per sempre senza errore visibile.
    // Fail fast qui, come faceva SendStrategy.send() prima della migrazione ai demoni.
    if (campaign.channelType === 'SEND' && campaign.channelConfig?.['protocolla'] !== true) {
      await this.campaignRepo.update({ id: campaignId }, { status: CampaignStatus.DRAFT });
      throw new BadRequestException('Protocollazione obbligatoria per SEND: channelConfig.protocolla deve essere true');
    }

    // SEND (atto legale) e POSTAL (lettera cartacea) senza nessun allegato
    // configurato invierebbero un PDF segnaposto generico come unico
    // documento notificato — non un caso d'uso reale, blocca a monte.
    if ((campaign.channelType === 'SEND' || campaign.channelType === 'POSTAL') && resolveAttachmentsConfig(campaign.channelConfig).length === 0) {
      await this.campaignRepo.update({ id: campaignId }, { status: CampaignStatus.DRAFT });
      return {
        launched: 0,
        campaignId,
        blocked: true,
        message: `Impossibile avviare: allegato obbligatorio per il canale ${campaign.channelType}. Configuralo al Passo 3 prima di rilanciare.`,
      };
    }

    const missingAttachments = await this.findMissingAttachments(campaign);
    if (missingAttachments.length > 0) {
      await this.campaignRepo.update({ id: campaignId }, { status: CampaignStatus.DRAFT });
      const sample = missingAttachments
        .slice(0, 5)
        .map((m) => `${m.expectedFilename} (CF ${m.codiceFiscale})`)
        .join(', ');
      const more = missingAttachments.length > 5 ? ', …' : '';
      
      const dir = getUploadsDir(campaignId);
      const presentFiles = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      const presentList = presentFiles.length > 0 ? presentFiles.slice(0, 10).join(', ') + (presentFiles.length > 10 ? '...' : '') : 'nessuno';

      // Risposta 200 (non BadRequestException): il reverse proxy di produzione
      // intercetta le risposte non-2xx e ne sostituisce il body con una pagina
      // HTML propria, rendendo illeggibile il messaggio lato frontend — stesso
      // problema già risolto altrove (vedi io-services.service.ts `test()`).
      return {
        launched: 0,
        campaignId,
        blocked: true,
        message: `Impossibile avviare: ${missingAttachments.length} allegato/i mancante/i rispetto alla mappatura configurata — es. ${sample}${more}. Carica i file mancanti prima di rilanciare. (Presenti in cartella: ${presentList})`,
      };
    }

    const recipients = await this.recipientRepo.find({
      where: { campaignId, status: RecipientStatus.PENDING },
      select: ['id'],
    });

    if (recipients.length === 0) {
      throw new BadRequestException('No pending recipients — upload a CSV first');
    }

    let channelOverrides: Map<string, NotificationChannel> | undefined;
    const inadCheckEnabled = campaign.channelType !== 'SEND' && (await this.settings.get<boolean>('inad.checkEnabled'));
    if (inadCheckEnabled) {
      if (recipients.length < INAD_BULK_THRESHOLD) {
        channelOverrides = await this.runInadExtractLoop(campaign, recipients);
      } else {
        const { launched } = await this.startInadBulkCheck(campaign, recipients);
        return { launched, campaignId };
      }
    }

    const { launched } = await this.createAttemptsAndEnqueue(campaign, recipients, channelOverrides);
    return { launched, campaignId };
  }

  private async runInadExtractLoop(
    campaign: Campaign,
    recipients: Array<{ id: string }>,
  ): Promise<Map<string, NotificationChannel>> {
    const fullRecipients = await this.recipientRepo.find({
      where: { id: In(recipients.map((r) => r.id)) },
      select: ['id', 'codiceFiscale', 'pec', 'email'],
    });
    const channelOverrides = new Map<string, NotificationChannel>();
    const CONCURRENCY = 5;
    for (let i = 0; i < fullRecipients.length; i += CONCURRENCY) {
      const batch = fullRecipients.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (recipient) => {
          if (!recipient.codiceFiscale) return;
          let result: { found: boolean; data?: { digitalAddress: Array<{ digitalAddress: string }> } };
          try {
            result = await this.inadService.extractDigitalAddress(recipient.codiceFiscale);
          } catch (err) {
            this.logger.warn(`Check INAD fallito per destinatario ${recipient.id} (CF ${recipient.codiceFiscale}): ${err instanceof Error ? err.message : err}`);
            return;
          }
          const found = result.found && (result.data?.digitalAddress?.length ?? 0) > 0;
          const inadAddress = found ? result.data!.digitalAddress[0].digitalAddress : null;
          await this.recipientRepo.update(
            { id: recipient.id },
            {
              inadCheck: {
                found,
                originalChannel: campaign.channelType,
                originalAddress: campaign.channelType === 'PEC' ? recipient.pec : recipient.email,
                checkedAt: new Date().toISOString(),
              },
              ...(found && inadAddress !== recipient.pec ? { pec: inadAddress } : {}),
            },
          );
          if (found && inadAddress !== recipient.pec) {
            channelOverrides.set(recipient.id, 'PEC');
          }
        }),
      );
    }
    return channelOverrides;
  }

  private async startInadBulkCheck(
    campaign: Campaign,
    recipients: Array<{ id: string }>,
  ): Promise<{ launched: number }> {
    const fullRecipients = await this.recipientRepo.find({
      where: { id: In(recipients.map((r) => r.id)) },
      select: ['id', 'codiceFiscale'],
    });
    const withCf = fullRecipients.filter((r) => r.codiceFiscale);

    const BATCH = 1000;
    const batches: Array<{ id: string; recipientIds: string[]; done: boolean }> = [];
    for (let i = 0; i < withCf.length; i += BATCH) {
      const chunk = withCf.slice(i, i + BATCH);
      const { id } = await this.inadService.startBulkExtraction(
        chunk.map((r) => r.codiceFiscale!),
        `comunicapa-campagna-${campaign.id}`,
      );
      batches.push({ id, recipientIds: chunk.map((r) => r.id), done: false });
    }

    if (batches.length === 0) {
      // Nessun destinatario ha un CF valorizzato (caso valido per EMAIL): non
      // c'è nulla da controllare su INAD. Entrare comunque in CHECKING_INAD
      // bloccherebbe la campagna per sempre — il demone (InadCheckSyncService)
      // salta le campagne con `pendingBatches.length === 0`, quindi
      // finalizeInadCheck non verrebbe mai chiamato automaticamente. Procedi
      // come se il check INAD fosse disabilitato per questa campagna.
      return this.createAttemptsAndEnqueue(campaign, recipients);
    }

    campaign.status = CampaignStatus.CHECKING_INAD;
    campaign.channelConfig = {
      ...campaign.channelConfig,
      inadCheck: { mechanism: 'bulk', batches, requestedAt: new Date().toISOString() },
    };
    await this.campaignRepo.save(campaign);
    return { launched: 0 };
  }

  /**
   * Applica i risultati di un check INAD bulk (Task 6) a una campagna in
   * CHECKING_INAD. Il chiamante (demone Task 8) deve aver già verificato che
   * i batch passati siano DISPONIBILE prima di invocare questo metodo — qui
   * si assume che `getBulkResult` per ogni batch non ancora `done` ritorni
   * risultati pronti. Riusa lo stesso audit `recipient.inadCheck` e la stessa
   * logica di override verso PEC di `runInadExtractLoop` (Task 5) — vedi
   * commento lì per il razionale found/address-diff.
   */
  async finalizeInadCheck(campaignId: string): Promise<void> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign || campaign.status !== CampaignStatus.CHECKING_INAD) return;

    const inadCheck = campaign.channelConfig?.['inadCheck'] as
      | { mechanism: 'bulk'; batches: Array<{ id: string; recipientIds: string[]; done: boolean }>; requestedAt: string }
      | undefined;
    if (!inadCheck) return;

    const pendingBatches = inadCheck.batches.filter((b) => !b.done);

    // Self-difesa: il chiamante "canonico" (demone Task 8) verifica già lo
    // stato DISPONIBILE prima di invocare questo metodo, ma il retry
    // manuale (`campaigns.controller.ts` `retryInadCheck`) chiama
    // finalizeInadCheck direttamente senza alcun pre-check — se un batch
    // non è ancora pronto, getBulkResult probabilmente lancia (4xx/dati
    // incompleti), che diventerebbe una pagina HTML illeggibile dietro il
    // reverse proxy di produzione. Fase 1: verifica lo stato di TUTTI i
    // batch pending PRIMA di processarne uno — se anche un solo batch non è
    // ancora pronto, abortisci senza alcun side-effect (niente getBulkResult,
    // niente scritture su recipient/batch/campagna). In caso contrario un
    // batch già pronto verrebbe processato e marcato `done` senza che il
    // save che persiste quel flag venga mai raggiunto (return anticipato su
    // un batch successivo non pronto), causando riprocessamenti ridondanti
    // ad ogni chiamata successiva.
    for (const batch of pendingBatches) {
      const state = await this.inadService.getBulkState(batch.id);
      if (state !== 'DISPONIBILE') {
        return;
      }
    }

    // Fase 2: tutti i batch pending sono DISPONIBILE — procedi a processarli.
    for (const batch of pendingBatches) {
      const result = await this.inadService.getBulkResult(batch.id);
      const resultByCf = new Map(result.map((r) => [r.codiceFiscale, r]));
      const batchRecipients = await this.recipientRepo.find({
        where: { id: In(batch.recipientIds) },
        select: ['id', 'codiceFiscale', 'pec', 'email'],
      });
      for (const recipient of batchRecipients) {
        const match = recipient.codiceFiscale ? resultByCf.get(recipient.codiceFiscale) : undefined;
        const found = !!match?.digitalAddress?.length;
        const inadAddress = found ? match!.digitalAddress![0].digitalAddress : null;
        await this.recipientRepo.update(
          { id: recipient.id },
          {
            inadCheck: {
              found,
              originalChannel: campaign.channelType,
              originalAddress: campaign.channelType === 'PEC' ? recipient.pec : recipient.email,
              checkedAt: new Date().toISOString(),
            },
            ...(found && inadAddress !== recipient.pec ? { pec: inadAddress } : {}),
          },
        );
      }
      batch.done = true;
    }

    campaign.channelConfig = { ...campaign.channelConfig, inadCheck };
    await this.campaignRepo.save(campaign);

    if (inadCheck.batches.every((b) => b.done)) {
      // Guardia atomica: solo il chiamante che riesce a far avanzare lo stato
      // CHECKING_INAD -> QUEUED procede a creare gli attempt. Previene doppie
      // invocazioni concorrenti (es. cron overlap + retry manuale) dal creare
      // entrambe NotificationAttempt duplicati per gli stessi destinatari —
      // stesso idioma di `launch()`.
      const finalizeResult = await this.campaignRepo
        .createQueryBuilder()
        .update()
        .set({ status: CampaignStatus.QUEUED })
        .where('id = :id AND status = :checking', { id: campaignId, checking: CampaignStatus.CHECKING_INAD })
        .execute();

      if (finalizeResult.affected === 0) {
        // Un'altra invocazione concorrente ha già vinto la transizione: non
        // ricreare gli attempt.
        return;
      }

      const overriddenRecipients = await this.recipientRepo.find({
        where: { id: In(inadCheck.batches.flatMap((b) => b.recipientIds)), status: RecipientStatus.PENDING },
        select: ['id', 'pec', 'inadCheck'],
      });
      const channelOverrides = new Map<string, NotificationChannel>();
      for (const r of overriddenRecipients) {
        if (r.inadCheck?.found && campaign.channelType !== 'PEC') {
          channelOverrides.set(r.id, 'PEC');
        }
      }
      const allRecipients = await this.recipientRepo.find({
        where: { campaignId: campaign.id, status: RecipientStatus.PENDING },
        select: ['id'],
      });
      await this.createAttemptsAndEnqueue(campaign, allRecipients, channelOverrides);
    }
  }

  private async createAttemptsAndEnqueue(
    campaign: Campaign,
    recipients: Array<{ id: string }>,
    channelOverrides?: Map<string, NotificationChannel>,
  ): Promise<{ launched: number }> {
    // Bulk insert NotificationAttempts in chunks di 500
    const CHUNK = 500;
    const attemptIds: string[] = [];
    for (let i = 0; i < recipients.length; i += CHUNK) {
      const chunk = recipients.slice(i, i + CHUNK);
      const result = await this.attemptRepo
        .createQueryBuilder()
        .insert()
        .into(NotificationAttempt)
        .values(
          chunk.map((r) => ({
            recipientId: r.id,
            channelType: channelOverrides?.get(r.id) ?? campaign.channelType,
            status: AttemptStatus.QUEUED,
          })),
        )
        .returning('id')
        .execute();
      attemptIds.push(...(result.raw as Array<{ id: string }>).map((row) => row.id));
    }

    // Accoda job BullMQ in bulk (chunk di 1000 per evitare payload Redis troppo
    // grandi). SEND non ha una propria coda di invio (SendDispatchService resta
    // poll-based, vedi pipeline-demoni-send-design) ma la protocollazione
    // (sempre richiesta per SEND, enforced sopra) sì: motore dedicato con
    // coda/UI/log come gli altri canali.
    const JOB_CHUNK = 1000;
    const engineName = (campaign.channelType === 'SEND' || campaign.channelConfig?.['protocolla'] === true) ? 'PROTOCOLLAZIONE' : campaign.channelType;
    for (let i = 0; i < recipients.length; i += JOB_CHUNK) {
      const chunk = recipients.slice(i, i + JOB_CHUNK);
      await this.notificationQueues.addBulk(
        engineName,
        chunk.map((r, idx) => ({
          name: NOTIFICATION_JOB_SEND,
          data: {
            campaignId: campaign.id,
            recipientId: r.id,
            attemptId: attemptIds[i + idx],
            channel: channelOverrides?.get(r.id) ?? campaign.channelType,
          },
          opts: { jobId: attemptIds[i + idx] },
        })),
      );
    }

    await this.recipientRepo.update(
      { campaignId: campaign.id, status: RecipientStatus.PENDING },
      { status: RecipientStatus.QUEUED },
    );

    return { launched: recipients.length };
  }

  async cancel(campaignId: string): Promise<{ cancelled: number; campaignId: string }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    if (campaign.status !== CampaignStatus.QUEUED && campaign.status !== CampaignStatus.CHECKING_INAD) {
      throw new BadRequestException('Solo campagne in corso o in verifica INAD possono essere annullate');
    }

    const queuedRecipients = await this.recipientRepo.find({
      where: { campaignId, status: RecipientStatus.QUEUED },
      select: ['id', 'extraData'],
    });
    const queuedById = new Map(queuedRecipients.map((r) => [r.id, r]));

    let cancelled = 0;
    if (queuedRecipients.length > 0) {
      const recipientIds = queuedRecipients.map((r) => r.id);
      const liveAttempts = await this.attemptRepo.find({
        where: { recipientId: In(recipientIds), status: AttemptStatus.QUEUED },
      });

      let removedAttemptIds: string[];
      let removedRecipientIds: string[];

      if (campaign.channelType === 'SEND') {
        // SEND non passa da BullMQ: annulla tutti gli attempt ancora QUEUED
        // (non protocollati, o protocollati ma non ancora inviati — in
        // entrambi i casi lo status resta QUEUED finché SendDispatchService
        // non lo marca SUCCESS/FAILED) con un update diretto su DB.
        //
        // `returning('id')` invece di un update() cieco: SendDispatchService
        // gira in parallelo (cron) e può aver già marcato un attempt
        // SUCCESS/FAILED tra la find() sopra e questo update — senza
        // riportare quali id l'UPDATE ha davvero toccato, il recipient
        // verrebbe comunque marcato CANCELLED anche se l'attempt è già
        // stato inviato (recipient CANCELLED ma notifica reale spedita).
        removedAttemptIds = [];
        removedRecipientIds = [];
        const candidateAttemptIds = liveAttempts.map((a) => a.id);
        if (candidateAttemptIds.length > 0) {
          const recipientByAttemptId = new Map(liveAttempts.map((a) => [a.id, a.recipientId]));
          const updateResult = await this.attemptRepo
            .createQueryBuilder()
            .update(NotificationAttempt)
            .set({ status: AttemptStatus.CANCELLED })
            .where('id IN (:...ids) AND status = :status', {
              ids: candidateAttemptIds,
              status: AttemptStatus.QUEUED,
            })
            .returning('id')
            .execute();
          removedAttemptIds = (updateResult.raw as Array<{ id: string }>).map((row) => row.id);
          removedRecipientIds = removedAttemptIds.map((id) => recipientByAttemptId.get(id)!);

          for (const removedId of removedAttemptIds) {
            try {
              const job = await this.notificationQueues.getJob('PROTOCOLLAZIONE', removedId);
              if (job) await job.remove();
            } catch (err) {
              this.logger.warn(`Job protocollazione ${removedId} non rimosso: ${err instanceof Error ? err.message : err}`);
            }
          }
        }
      } else {
        removedAttemptIds = [];
        removedRecipientIds = [];
        for (const attempt of liveAttempts) {
          const job = await this.notificationQueues.getJob(
            campaign.channelType as Exclude<typeof campaign.channelType, 'SEND'>,
            attempt.id,
          );
          if (!job) continue;
          try {
            await job.remove();
            removedAttemptIds.push(attempt.id);
            removedRecipientIds.push(attempt.recipientId);
          } catch (err) {
            this.logger.warn(
              `Job ${attempt.id} non rimosso (probabilmente in elaborazione): ${err instanceof Error ? err.message : err}`,
            );
          }
        }
        if (removedAttemptIds.length > 0) {
          await this.attemptRepo.update({ id: In(removedAttemptIds) }, { status: AttemptStatus.CANCELLED });
        }
      }

      if (removedRecipientIds.length > 0) {
        await this.recipientRepo.update({ id: In(removedRecipientIds) }, { status: RecipientStatus.CANCELLED });

        // Il destinatario cancellato non riceverà mai la notifica: l'allegato
        // personalizzato non serve più (non c'è download da servire), elimina
        // subito invece di aspettare la scadenza retention.
        const attachmentsConfig = resolveAttachmentsConfig(campaign.channelConfig);
        const totalSlots = Math.max(attachmentsConfig.length, 1);
        const dir = getUploadsDir(campaignId);
        for (const recipientId of removedRecipientIds) {
          const recipient = queuedById.get(recipientId);
          if (!recipient) continue;
          for (let index = 0; index < totalSlots; index++) {
            const filename = resolveCustomAttachmentFilename(
              { campaign, extraData: recipient.extraData } as unknown as Recipient,
              index,
            );
            if (!filename) continue;
            try {
              await unlink(join(dir, filename));
            } catch (err) {
              this.logger.warn(`Allegato già assente o non eliminabile: ${filename}`);
            }
          }
        }
        await this.recipientRepo.update({ id: In(removedRecipientIds) }, { attachmentDeletedAt: new Date() });
      }
      cancelled = removedRecipientIds.length;
    }

    await this.campaignRepo
      .createQueryBuilder()
      .update()
      .set({ status: CampaignStatus.CANCELLED, completedAt: new Date() })
      .where('id = :id AND status IN (:...statuses)', {
        id: campaignId,
        statuses: [CampaignStatus.QUEUED, CampaignStatus.CHECKING_INAD],
      })
      .execute();

    return { cancelled, campaignId };
  }

  /**
   * Sblocco manuale (Task 9, bottone "Salta verifica") per una campagna
   * bloccata in CHECKING_INAD — lancia con i canali ORIGINALI di campagna,
   * nessun override PEC (a differenza di `finalizeInadCheck`, qui il check
   * INAD non viene mai completato). Usa la stessa guardia atomica di
   * `finalizeInadCheck` (Task 6) sulla transizione CHECKING_INAD -> QUEUED
   * per restare sicuro anche in caso di race con `finalizeInadCheck` o con
   * un'altra chiamata concorrente a `skipInadCheck` sulla stessa campagna.
   */
  async skipInadCheck(campaignId: string): Promise<{ launched: number; campaignId: string }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    if (campaign.status !== CampaignStatus.CHECKING_INAD) {
      throw new BadRequestException('Solo le campagne in verifica INAD possono saltare il controllo');
    }

    const skipResult = await this.campaignRepo
      .createQueryBuilder()
      .update()
      .set({ status: CampaignStatus.QUEUED })
      .where('id = :id AND status = :checking', { id: campaignId, checking: CampaignStatus.CHECKING_INAD })
      .execute();

    if (skipResult.affected === 0) {
      // Un'altra invocazione concorrente ha già vinto la transizione (es.
      // finalizeInadCheck o un altro skipInadCheck): non ricreare gli attempt.
      return { launched: 0, campaignId };
    }

    const recipients = await this.recipientRepo.find({
      where: { campaignId, status: RecipientStatus.PENDING },
      select: ['id'],
    });
    const { launched } = await this.createAttemptsAndEnqueue(campaign, recipients);
    campaign.status = CampaignStatus.QUEUED;
    await this.campaignRepo.save(campaign);
    return { launched, campaignId };
  }

  async getStats(campaignId: string): Promise<CampaignStatsDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipients = await this.recipientRepo.find({
      where: { campaignId },
      select: ['downloadCount', 'lastDownloadedAt'],
    });

    const totalDownloaded = recipients.filter((r) => r.downloadCount > 0).length;
    const lastDownloadAt = recipients.reduce<Date | null>((latest, r) => {
      if (!r.lastDownloadedAt) return latest;
      if (!latest || r.lastDownloadedAt > latest) return r.lastDownloadedAt;
      return latest;
    }, null);

    return {
      campaignId,
      totalRecipients: campaign.totalRecipients,
      totalSent: campaign.sentCount,
      totalDownloaded,
      downloadPercentage: campaign.totalRecipients > 0
        ? Math.round((totalDownloaded / campaign.totalRecipients) * 100)
        : 0,
      lastDownloadAt,
    };
  }

  /**
   * Breakdown per canale/co-consegna App IO. Ritorna null se la campagna non
   * ha co-consegna configurata (nessuna sezione da mostrare). Il segnale App IO
   * esiste solo sul PRIMO tentativo (job.attemptsMade === 0 in
   * notification.processor.ts — la co-consegna non viene mai ritentata), quindi
   * si legge solo attemptNumber=1; lo stato primario invece è quello ATTUALE
   * del destinatario (aggiornato anche dai retry).
   */
  async getChannelBreakdown(campaignId: string): Promise<ChannelBreakdownDto | null> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    if (!resolveSecondaryAppIoConfig(campaign.channelConfig)) return null;

    const recipients = await this.recipientRepo.find({
      where: { campaignId },
      select: ['id', 'status'],
    });

    const breakdown: ChannelBreakdownDto = { primaryOnly: 0, both: 0, appIoOnly: 0, appIoDespitePrimaryFail: 0, neither: 0 };
    const toClassify = recipients.filter(
      (r) => r.status === RecipientStatus.SENT || r.status === RecipientStatus.FAILED,
    );
    if (toClassify.length === 0) return breakdown;

    const firstAttempts = await this.attemptRepo.find({
      where: { recipientId: In(toClassify.map((r) => r.id)), attemptNumber: 1 },
      select: ['recipientId', 'responsePayload'],
    });
    const payloadByRecipient = new Map(firstAttempts.map((a) => [a.recipientId, a.responsePayload]));

    for (const r of toClassify) {
      const payload = payloadByRecipient.get(r.id);
      const appIo = payload?.['appIo'] as { success?: boolean } | undefined;
      const deliveredViaAppIo = payload?.['deliveredVia'] === 'APP_IO';
      const appIoSucceeded = !!appIo?.success;
      const primarySucceeded = r.status === RecipientStatus.SENT && !deliveredViaAppIo;

      if (primarySucceeded && appIoSucceeded) breakdown.both++;
      else if (primarySucceeded) breakdown.primaryOnly++;
      else if (deliveredViaAppIo && appIoSucceeded) breakdown.appIoOnly++;
      else if (r.status === RecipientStatus.FAILED && appIoSucceeded) breakdown.appIoDespitePrimaryFail++;
      else breakdown.neither++;
    }
    return breakdown;
  }

  /**
   * Conteggi a stadi per la barra di progresso SEND nel dettaglio di UNA
   * campagna (versione scoped di `GET admin/engines/send/stage-counts`, che
   * conta invece su tutte le campagne). Stessa forma `{queued, protocollato,
   * inviato, fallito}`.
   */
  async getSendStageCounts(campaignId: string): Promise<{ queued: number; protocollato: number; inviato: number; fallito: number }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const baseQb = () =>
      this.attemptRepo
        .createQueryBuilder('attempt')
        .innerJoin('attempt.recipient', 'recipient')
        .where('recipient.campaignId = :campaignId', { campaignId })
        .andWhere('attempt.channel_type = :ch', { ch: campaign.channelType });

    const [queued, protocollato, inviato, fallito] = await Promise.all([
      baseQb().andWhere('attempt.status = :status', { status: AttemptStatus.QUEUED }).andWhere('attempt.protocolled_at IS NULL').getCount(),
      baseQb().andWhere('attempt.status = :status', { status: AttemptStatus.QUEUED }).andWhere('attempt.protocolled_at IS NOT NULL').getCount(),
      baseQb().andWhere('attempt.status = :status', { status: AttemptStatus.SUCCESS }).getCount(),
      baseQb().andWhere('attempt.status = :status', { status: AttemptStatus.FAILED }).getCount(),
    ]);

    return { queued, protocollato, inviato, fallito };
  }

  /**
   * Combinazione canali di download per destinatario, tra i soli destinatari
   * notificati con successo (primario SENT, oppure App IO co-consegna
   * riuscita nonostante il primario fallito). I destinatari mai notificati
   * (falliti, senza alcun canale riuscito) non hanno mai avuto un link da
   * scaricare: mescolarli nel bucket "nessun download" renderebbe la
   * percentuale fuorviante su campagne con molti fallimenti — restano
   * visibili nel grafico "Esito Invio", non qui.
   * Generico per qualsiasi tipo di campagna: raggruppa per i canali
   * realmente osservati nei DownloadEvent (portale, primario, App IO...),
   * non assume quali esistano. Se un destinatario NON notificato risulta
   * comunque avere scaricato (es. link portale ancora valido da un invio
   * precedente), la combinazione viene marcata `sentSuccessfully: false` e va
   * mostrata separatamente lato UI, fuori dalla percentuale sul totale.
   */
  async getDownloadCombinationStats(campaignId: string): Promise<DownloadCombinationStatsDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipients = await this.recipientRepo.find({ where: { campaignId }, select: ['id', 'status'] });
    if (recipients.length === 0) return { sentCount: 0, combinations: [] };

    const appIoSuccessByRecipient = new Map<string, boolean>();
    if (resolveSecondaryAppIoConfig(campaign.channelConfig)) {
      const nonSentIds = recipients.filter((r) => r.status !== RecipientStatus.SENT).map((r) => r.id);
      if (nonSentIds.length > 0) {
        const firstAttempts = await this.attemptRepo.find({
          where: { recipientId: In(nonSentIds), attemptNumber: 1 },
          select: ['recipientId', 'responsePayload'],
        });
        for (const a of firstAttempts) {
          const appIo = a.responsePayload?.['appIo'] as { success?: boolean } | undefined;
          if (appIo?.success) appIoSuccessByRecipient.set(a.recipientId, true);
        }
      }
    }
    const wasNotified = (r: { id: string; status: RecipientStatus }) =>
      r.status === RecipientStatus.SENT || appIoSuccessByRecipient.get(r.id) === true;

    const rows = await this.downloadEventRepo
      .createQueryBuilder('de')
      .innerJoin('de.recipient', 'r')
      .select('de.recipientId', 'recipientId')
      .addSelect('de.channel', 'channel')
      .where('r.campaignId = :campaignId', { campaignId })
      .getRawMany<{ recipientId: string; channel: string }>();

    const channelsByRecipient = new Map<string, Set<string>>();
    for (const row of rows) {
      if (!channelsByRecipient.has(row.recipientId)) channelsByRecipient.set(row.recipientId, new Set());
      channelsByRecipient.get(row.recipientId)!.add(row.channel);
    }

    const countByKey = new Map<string, DownloadCombinationDto>();
    let sentCount = 0;
    let notDownloadedSent = 0;
    for (const recipient of recipients) {
      const notified = wasNotified(recipient);
      if (notified) sentCount++;

      const channels = channelsByRecipient.get(recipient.id);
      if (!channels || channels.size === 0) {
        if (notified) notDownloadedSent++;
        // Non notificato e non scaricato: nessun link è mai esistito, non
        // interessante per questo grafico (già coperto da "Esito Invio").
        continue;
      }
      const sorted = [...channels].sort();
      const key = `${notified}|${sorted.join('+')}`;
      const existing = countByKey.get(key);
      if (existing) existing.count++;
      else countByKey.set(key, { channels: sorted, count: 1, sentSuccessfully: notified });
    }

    const combinations = [...countByKey.values()];
    if (notDownloadedSent > 0) combinations.push({ channels: [], count: notDownloadedSent, sentSuccessfully: true });
    return { sentCount, combinations };
  }

  async getGlobalStats(dateFrom?: string, dateTo?: string): Promise<GlobalStatsDto> {
    const range = buildDateRangeWhere('c', dateFrom, dateTo);

    const totalsRow = await this.campaignRepo
      .createQueryBuilder('c')
      .select('COALESCE(SUM(c.totalRecipients), 0)', 'totalRecipients')
      .addSelect('COALESCE(SUM(c.sentCount), 0)', 'totalSent')
      .addSelect('COALESCE(SUM(c.failedCount), 0)', 'totalFailed')
      .where(range.sql, range.params)
      .getRawOne<{ totalRecipients: string; totalSent: string; totalFailed: string }>();

    const totalDownloaded = await this.recipientRepo
      .createQueryBuilder('r')
      .innerJoin('r.campaign', 'c')
      .where('r.downloadCount > 0')
      .andWhere(range.sql, range.params)
      .getCount();

    const sentTrendRows = await this.campaignRepo
      .createQueryBuilder('c')
      .select("to_char(date_trunc('month', c.createdAt), 'YYYY-MM')", 'month')
      .addSelect('COALESCE(SUM(c.sentCount), 0)', 'sent')
      .where(range.sql, range.params)
      .groupBy("date_trunc('month', c.createdAt)")
      .orderBy("date_trunc('month', c.createdAt)", 'ASC')
      .getRawMany<{ month: string; sent: string }>();

    const downloadedTrendRows = await this.recipientRepo
      .createQueryBuilder('r')
      .innerJoin('r.campaign', 'c')
      .select("to_char(date_trunc('month', c.createdAt), 'YYYY-MM')", 'month')
      .addSelect('COUNT(*) FILTER (WHERE r.downloadCount > 0)', 'downloaded')
      .where(range.sql, range.params)
      .groupBy("date_trunc('month', c.createdAt)")
      .getRawMany<{ month: string; downloaded: string }>();

    const channelRows = await this.campaignRepo
      .createQueryBuilder('c')
      .select('c.channelType', 'channel')
      .addSelect('COALESCE(SUM(c.sentCount), 0)', 'sent')
      .where(range.sql, range.params)
      .groupBy('c.channelType')
      .getRawMany<{ channel: string; sent: string }>();

    const downloadChannelRows = await this.downloadEventRepo
      .createQueryBuilder('de')
      .innerJoin('de.recipient', 'r')
      .innerJoin('r.campaign', 'c')
      .select('de.channel', 'channel')
      .addSelect('COUNT(*)', 'count')
      .where(range.sql, range.params)
      .groupBy('de.channel')
      .getRawMany<{ channel: string; count: string }>();

    const leaderboardRows = await this.campaignRepo
      .createQueryBuilder('c')
      .leftJoin('c.recipients', 'r')
      .select('c.id', 'campaignId')
      .addSelect('c.name', 'campaignName')
      .addSelect('c.totalRecipients', 'totalRecipients')
      .addSelect('COUNT(*) FILTER (WHERE r.downloadCount > 0)', 'downloadedCount')
      .where('c.totalRecipients > 0')
      .andWhere(range.sql, range.params)
      .groupBy('c.id')
      .getRawMany<{ campaignId: string; campaignName: string; totalRecipients: string; downloadedCount: string }>();

    const neverDownloadedCount = await this.recipientRepo
      .createQueryBuilder('r')
      .innerJoin('r.campaign', 'c')
      .where('r.downloadCount = 0')
      .andWhere('r.status = :status', { status: RecipientStatus.SENT })
      .andWhere(range.sql, range.params)
      .getCount();

    const totalRecipients = Number(totalsRow?.totalRecipients ?? 0);
    const totalSent = Number(totalsRow?.totalSent ?? 0);
    const totalFailed = Number(totalsRow?.totalFailed ?? 0);

    return {
      totals: {
        totalRecipients,
        totalSent,
        totalFailed,
        totalDownloaded,
        downloadPercentage: computeDownloadPercentage(totalDownloaded, totalRecipients),
      },
      monthlyTrend: mergeMonthlyTrend(sentTrendRows, downloadedTrendRows),
      channelTotals: channelRows.map((r) => ({ channel: r.channel, sent: Number(r.sent) })),
      downloadChannelTotals: downloadChannelRows.map((r) => ({ channel: r.channel, count: Number(r.count) })),
      campaignLeaderboard: leaderboardRows
        .map((r) => ({
          campaignId: r.campaignId,
          campaignName: r.campaignName,
          totalRecipients: Number(r.totalRecipients),
          downloadPercentage: computeDownloadPercentage(Number(r.downloadedCount), Number(r.totalRecipients)),
        }))
        .sort((a, b) => b.downloadPercentage - a.downloadPercentage),
      neverDownloadedCount,
    };
  }

  async getNeverDownloadedRecipients(dateFrom?: string, dateTo?: string): Promise<NeverDownloadedRowDto[]> {
    const range = buildDateRangeWhere('c', dateFrom, dateTo);
    const rows = await this.recipientRepo
      .createQueryBuilder('r')
      .innerJoinAndSelect('r.campaign', 'c')
      .where('r.downloadCount = 0')
      .andWhere('r.status = :status', { status: RecipientStatus.SENT })
      .andWhere(range.sql, range.params)
      .orderBy('r.createdAt', 'DESC')
      .getMany();

    return rows.map((r) => ({
      codiceFiscale: r.codiceFiscale,
      fullName: r.fullName,
      campaignName: r.campaign.name,
      channelType: r.campaign.channelType,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async getFailures(campaignId: string): Promise<FailureRowDto[]> {
    // Query singola con subquery DISTINCT ON invece di una findOne per
    // destinatario: con decine di migliaia di FAILED la versione N+1
    // precedente rendeva il caricamento del dettaglio campagna impraticabile.
    const rows = await this.recipientRepo
      .createQueryBuilder('r')
      .leftJoin(
        `(SELECT DISTINCT ON (recipient_id) recipient_id, error_message, attempt_number, created_at
          FROM notification_attempts ORDER BY recipient_id, attempt_number DESC)`,
        'la',
        'la.recipient_id = r.id',
      )
      .select('r.id', 'recipientId')
      .addSelect('r.codiceFiscale', 'codiceFiscale')
      .addSelect('r.fullName', 'fullName')
      .addSelect('la.error_message', 'errorMessage')
      .addSelect('la.attempt_number', 'attemptNumber')
      .addSelect('la.created_at', 'lastAttemptAt')
      .addSelect('r.createdAt', 'recipientCreatedAt')
      .where('r.campaignId = :campaignId', { campaignId })
      .andWhere('r.status = :status', { status: RecipientStatus.FAILED })
      .orderBy('r.createdAt', 'DESC')
      .getRawMany<{
        recipientId: string;
        codiceFiscale: string;
        fullName: string | null;
        errorMessage: string | null;
        attemptNumber: number | null;
        lastAttemptAt: Date | null;
        recipientCreatedAt: Date;
      }>();

    return rows.map((r) => ({
      recipientId: r.recipientId,
      codiceFiscale: r.codiceFiscale,
      fullName: r.fullName,
      errorMessage: r.errorMessage,
      attemptNumber: r.attemptNumber ?? 0,
      lastAttemptAt: (r.lastAttemptAt ?? r.recipientCreatedAt).toISOString(),
    }));
  }

  async getFailuresByReason(campaignId: string): Promise<FailureGroupDto[]> {
    const failures = await this.getFailures(campaignId);
    const groups = new Map<string, FailureGroupDto>();

    for (const f of failures) {
      const key = f.errorMessage ?? 'Errore sconosciuto';
      if (!groups.has(key)) groups.set(key, { errorMessage: key, count: 0, recipientIds: [] });
      const group = groups.get(key)!;
      group.count++;
      group.recipientIds.push(f.recipientId);
    }

    return Array.from(groups.values()).sort((a, b) => b.count - a.count);
  }

  async retryRecipient(campaignId: string, recipientId: string): Promise<{ requeued: true; attemptId: string }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    if (campaign.status === CampaignStatus.CANCELLED) {
      throw new BadRequestException('Non è possibile rimettere in coda destinatari di una campagna annullata');
    }

    const recipient = await this.recipientRepo.findOne({ where: { id: recipientId } });
    if (!recipient || recipient.campaignId !== campaignId) {
      throw new NotFoundException(`Recipient ${recipientId} non trovato in questa campagna`);
    }
    if (recipient.status !== RecipientStatus.FAILED) {
      throw new BadRequestException('Solo i destinatari in stato FAILED possono essere rimessi in coda');
    }

    const lastAttempt = await this.attemptRepo.findOne({
      where: { recipientId },
      order: { attemptNumber: 'DESC' },
    });
    const nextAttemptNumber = (lastAttempt?.attemptNumber ?? 0) + 1;

    // SEND: se l'ultimo tentativo era già protocollato, il nuovo attempt eredita
    // lo stesso protocolNumber/protocolYear/protocolledAt invece di richiedere un
    // nuovo protocollo reale al demone — il documento non è cambiato, un retry
    // (es. dopo un errore di configurazione/rete verso PN) non giustifica una
    // nuova protocollazione. Riprotocolla da zero solo se l'ultimo tentativo
    // non era mai arrivato a protocollare (protocolledAt ancora null).
    const inheritedProtocol =
      (campaign.channelType === 'SEND' || campaign.channelConfig?.['protocolla'] === true) && lastAttempt?.protocolledAt
        ? {
            protocolNumber: lastAttempt.protocolNumber,
            protocolYear: lastAttempt.protocolYear,
            protocolledAt: lastAttempt.protocolledAt,
          }
        : {};

    // SEND: se l'ultimo tentativo aveva già caricato allegati su PN, il nuovo
    // attempt li eredita — l'oggetto è già su S3 (key/versionToken restano
    // validi), ricaricarlo sprecherebbe tempo/banda senza motivo se il
    // documento non è cambiato tra un retry e l'altro.
    const inheritedUploads =
      campaign.channelType === 'SEND' && lastAttempt?.uploadedDocuments?.length
        ? { uploadedDocuments: lastAttempt.uploadedDocuments }
        : {};

    const result = await this.attemptRepo
      .createQueryBuilder()
      .insert()
      .into(NotificationAttempt)
      .values({
        recipientId,
        channelType: campaign.channelType,
        status: AttemptStatus.QUEUED,
        attemptNumber: nextAttemptNumber,
        ...inheritedProtocol,
        ...inheritedUploads,
      })
      .returning('id')
      .execute();
    const attemptId = (result.raw as Array<{ id: string }>)[0].id;

    await this.recipientRepo.update({ id: recipientId }, { status: RecipientStatus.QUEUED });
    await this.campaignRepo.decrement({ id: campaignId }, 'failedCount', 1);

    const needsProtocolla = campaign.channelConfig?.['protocolla'] === true;
    if (campaign.channelType !== 'SEND' && !needsProtocolla) {
      await this.notificationQueues.addBulk(campaign.channelType as Exclude<typeof campaign.channelType, 'SEND'>, [
        { name: NOTIFICATION_JOB_SEND, data: { campaignId, recipientId, attemptId, channel: campaign.channelType }, opts: { jobId: attemptId } },
      ]);
    } else if (campaign.channelType !== 'SEND' && needsProtocolla && inheritedProtocol.protocolledAt) {
      await this.notificationQueues.addBulk(campaign.channelType as Exclude<typeof campaign.channelType, 'SEND'>, [
        { name: NOTIFICATION_JOB_SEND, data: { campaignId, recipientId, attemptId, channel: campaign.channelType }, opts: { jobId: attemptId } },
      ]);
    } else if (!inheritedProtocol.protocolledAt) {
      // Non eredita un protocollo già fatto: va (ri)protocollato dal motore dedicato.
      await this.notificationQueues.addBulk('PROTOCOLLAZIONE', [
        { name: NOTIFICATION_JOB_SEND, data: { campaignId, recipientId, attemptId, channel: campaign.channelType }, opts: { jobId: attemptId } },
      ]);
    }

    return { requeued: true, attemptId };
  }

  async retryRecipientsBulk(campaignId: string, recipientIds: string[]): Promise<RetryBulkResultDto> {
    if (recipientIds.length > MAX_BULK_RETRY_SIZE) {
      throw new BadRequestException(
        `Impossibile rimettere in coda più di ${MAX_BULK_RETRY_SIZE} destinatari in una sola richiesta (richiesti: ${recipientIds.length}). Riduci la selezione o contatta l'amministratore per un'operazione batch.`,
      );
    }

    let requeued = 0;
    const failed: Array<{ recipientId: string; reason: string }> = [];

    for (const recipientId of recipientIds) {
      try {
        await this.retryRecipient(campaignId, recipientId);
        requeued++;
      } catch (e) {
        failed.push({ recipientId, reason: e instanceof Error ? e.message : 'Errore sconosciuto' });
      }
    }

    return { requeued, failed };
  }

  async getRecipientStats(campaignId: string, page: number, pageSize: number, search?: string): Promise<RecipientStatsPageDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const qb = this.recipientRepo
      .createQueryBuilder('r')
      .select([
        'r.id', 'r.fullName', 'r.codiceFiscale', 'r.email', 'r.pec', 'r.status',
        'r.downloadCount', 'r.firstDownloadedAt', 'r.lastDownloadedAt', 'r.attachmentDeletedAt',
      ])
      .where('r.campaignId = :campaignId', { campaignId });

    if (search && search.trim()) {
      qb.andWhere('(r.fullName ILIKE :search OR r.codiceFiscale ILIKE :search)', { search: `%${search.trim()}%` });
    }

    const [rawItems, total] = await qb
      .orderBy('r.createdAt', 'ASC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    // Selezione parziale via .select(): il risultato ha solo i campi
    // proiettati (compatibili con RecipientStatDto), non un Recipient
    // completo — tipizzato esplicitamente per poter assegnare le colonne
    // SEND opzionali qui sotto.
    const items: RecipientStatDto[] = rawItems;

    if ((campaign.channelType === 'SEND' || campaign.channelType === 'POSTAL' || campaign.channelConfig?.['protocolla'] === true) && items.length > 0) {
      // Due query separate invece di leftJoinAndSelect: stesso motivo del
      // bug TypeORM documentato in protocollazione-sync.service.ts/
      // send-dispatch.service.ts (leftJoinAndSelect + orderBy + take su
      // relazione dichiarata per stringa). Qui il join sarebbe su una
      // relazione 1-a-molti (un destinatario può avere più attempt): il
      // riduttore "ultimo per destinatario" si fa in JS sul risultato,
      // batch piccolo (una pagina di destinatari), nessun impatto pratico.
      const recipientIds = items.map((r) => r.id);
      const attempts = await this.attemptRepo.find({
        where: { recipientId: In(recipientIds), channelType: campaign.channelType },
      });
      const latestByRecipient = new Map<string, NotificationAttempt>();
      for (const a of attempts) {
        const current = latestByRecipient.get(a.recipientId);
        if (!current || a.attemptNumber > current.attemptNumber) {
          latestByRecipient.set(a.recipientId, a);
        }
      }
      for (const item of items) {
        const latest = latestByRecipient.get(item.id);
        if (latest) {
          item.iun = latest.iun;
          item.sendStatus = latest.sendStatus;
          item.sendStatusUpdatedAt = latest.sendStatusUpdatedAt;
          item.protocolNumber = latest.protocolNumber;
          item.protocolYear = latest.protocolYear;
          item.postalTrackingId = latest.postalTrackingId;
          item.postalStatus = latest.postalStatus;
          item.postalStatusUpdatedAt = latest.postalStatusUpdatedAt;
        }
      }
    }

    return { campaignId, page, pageSize, total, items };
  }

  async getDownloadReportRows(campaignId: string): Promise<DownloadReportRowDto[]> {
    const rows = await this.recipientRepo.find({
      where: { campaignId },
      select: ['codiceFiscale', 'fullName', 'email', 'pec', 'status', 'downloadCount', 'lastDownloadedAt'],
      order: { createdAt: 'ASC' },
    });

    return rows.map((r) => ({
      codiceFiscale: r.codiceFiscale,
      fullName: r.fullName,
      email: r.email,
      pec: r.pec,
      status: r.status,
      downloadCount: r.downloadCount,
      lastDownloadedAt: r.lastDownloadedAt ? r.lastDownloadedAt.toISOString() : null,
    }));
  }

  async getSendStatusBreakdown(campaignId: string): Promise<SendStatusBreakdownDto[]> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipientIds = (await this.recipientRepo.find({ where: { campaignId }, select: ['id'] })).map((r) => r.id);
    if (recipientIds.length === 0) return [];

    // Stesso pattern di getRecipientStats: due query separate invece di
    // leftJoinAndSelect (bug TypeORM con orderBy+take su relazione per
    // stringa), riduzione "ultimo attempt per destinatario" in JS.
    const attempts = await this.attemptRepo.find({
      where: { recipientId: In(recipientIds), channelType: 'SEND' },
      select: ['recipientId', 'attemptNumber', 'sendStatus', 'status'],
    });

    const latestByRecipient = new Map<string, NotificationAttempt>();
    for (const a of attempts) {
      const current = latestByRecipient.get(a.recipientId);
      if (!current || a.attemptNumber > current.attemptNumber) latestByRecipient.set(a.recipientId, a);
    }

    const counts = new Map<string | null, number>();
    for (const a of latestByRecipient.values()) {
      const key = a.status === AttemptStatus.FAILED ? 'FAILED' : a.sendStatus;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return Array.from(counts.entries()).map(([status, count]) => ({ status, count }));
  }

  async getSendReportRows(campaignId: string): Promise<SendReportDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipients = await this.recipientRepo.find({
      where: { campaignId },
      select: ['id', 'codiceFiscale', 'fullName'],
      order: { createdAt: 'ASC' },
    });
    if (recipients.length === 0) return { hasAppIoCoDelivery: false, rows: [] };

    const recipientIds = recipients.map((r) => r.id);
    const attempts = await this.attemptRepo.find({
      where: { recipientId: In(recipientIds), channelType: 'SEND' },
    });

    const latestByRecipient = new Map<string, NotificationAttempt>();
    const firstByRecipient = new Map<string, NotificationAttempt>();
    for (const a of attempts) {
      const current = latestByRecipient.get(a.recipientId);
      if (!current || a.attemptNumber > current.attemptNumber) latestByRecipient.set(a.recipientId, a);
      // Segnale App IO esiste solo sul primo tentativo (mai ritentato),
      // stesso vincolo già documentato in getChannelBreakdown().
      if (a.attemptNumber === 1) firstByRecipient.set(a.recipientId, a);
    }

    const hasAppIoCoDelivery = !!resolveSecondaryAppIoConfig(campaign.channelConfig);

    const rows: SendReportRowDto[] = recipients.map((r) => {
      const latest = latestByRecipient.get(r.id);
      const first = firstByRecipient.get(r.id);
      const appIo = hasAppIoCoDelivery
        ? ((first?.responsePayload as Record<string, unknown> | undefined)?.['appIo'] as { success?: boolean; error?: string } | undefined)
        : undefined;

      return {
        codiceFiscale: r.codiceFiscale,
        fullName: r.fullName,
        iun: latest?.iun ?? null,
        digitalDomicileType: latest?.sendDigitalDomicile?.type ?? null,
        digitalDomicileAddress: latest?.sendDigitalDomicile?.address ?? null,
        sendStatus: latest?.status === AttemptStatus.FAILED ? 'FAILED' : (latest?.sendStatus ?? null),
        sendStatusHistory: latest?.sendStatusHistory ?? [],
        appIoOutcome: appIo ? { success: !!appIo.success, error: appIo.error ?? null } : null,
      };
    });

    return { hasAppIoCoDelivery, rows };
  }

  async getPostalStatusBreakdown(campaignId: string): Promise<PostalStatusBreakdownDto[]> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipientIds = (await this.recipientRepo.find({ where: { campaignId }, select: ['id'] })).map((r) => r.id);
    if (recipientIds.length === 0) return [];

    const attempts = await this.attemptRepo.find({
      where: { recipientId: In(recipientIds), channelType: 'POSTAL' },
      select: ['recipientId', 'attemptNumber', 'postalStatus', 'status'],
    });

    const latestByRecipient = new Map<string, NotificationAttempt>();
    for (const a of attempts) {
      const current = latestByRecipient.get(a.recipientId);
      if (!current || a.attemptNumber > current.attemptNumber) latestByRecipient.set(a.recipientId, a);
    }

    const counts = new Map<string | null, number>();
    for (const a of latestByRecipient.values()) {
      const key = a.status === AttemptStatus.FAILED ? 'FAILED' : a.postalStatus;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return Array.from(counts.entries()).map(([status, count]) => ({ status, count }));
  }

  async getPostalReportRows(campaignId: string): Promise<PostalReportDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipients = await this.recipientRepo.find({
      where: { campaignId },
      select: ['id', 'codiceFiscale', 'fullName'],
      order: { createdAt: 'ASC' },
    });
    if (recipients.length === 0) return { hasAppIoCoDelivery: false, rows: [] };

    const recipientIds = recipients.map((r) => r.id);
    const attempts = await this.attemptRepo.find({
      where: { recipientId: In(recipientIds), channelType: 'POSTAL' },
    });

    const latestByRecipient = new Map<string, NotificationAttempt>();
    const firstByRecipient = new Map<string, NotificationAttempt>();
    for (const a of attempts) {
      const current = latestByRecipient.get(a.recipientId);
      if (!current || a.attemptNumber > current.attemptNumber) latestByRecipient.set(a.recipientId, a);
      // Segnale App IO esiste solo sul primo tentativo (mai ritentato),
      // stesso vincolo già documentato in getChannelBreakdown()/getSendReportRows().
      if (a.attemptNumber === 1) firstByRecipient.set(a.recipientId, a);
    }

    const hasAppIoCoDelivery = !!resolveSecondaryAppIoConfig(campaign.channelConfig);

    const rows: PostalReportRowDto[] = recipients.map((r) => {
      const latest = latestByRecipient.get(r.id);
      const first = firstByRecipient.get(r.id);
      const appIo = hasAppIoCoDelivery
        ? ((first?.responsePayload as Record<string, unknown> | undefined)?.['appIo'] as { success?: boolean; error?: string } | undefined)
        : undefined;
      const latestPayload = latest?.responsePayload as Record<string, unknown> | undefined;

      return {
        codiceFiscale: r.codiceFiscale,
        fullName: r.fullName,
        postalTrackingId: latest?.postalTrackingId ?? null,
        postalStatus: latest?.status === AttemptStatus.FAILED ? 'FAILED' : (latest?.postalStatus ?? null),
        postalStatusHistory: latest?.postalStatusHistory ?? [],
        codiceErrore: (latestPayload?.['codiceErrore'] as string | undefined) ?? null,
        descrizioneErrore: (latestPayload?.['descrizione'] as string | undefined) ?? null,
        appIoOutcome: appIo ? { success: !!appIo.success, error: appIo.error ?? null } : null,
      };
    });

    return { hasAppIoCoDelivery, rows };
  }

  async assertDraftForAttachments(campaignId: string): Promise<void> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    if (campaign.status !== CampaignStatus.DRAFT) {
      throw new BadRequestException(
        'La campagna non è più in bozza: gli allegati non possono essere modificati dopo il lancio. Annulla e crea una nuova campagna per cambiarli.',
      );
    }
  }

  /**
   * Calcola gli allegati mancanti: per ogni destinatario PENDING e ogni slot
   * configurato, verifica che il file referenziato in extraData esista
   * davvero nella cartella uploads della campagna. Usato per bloccare il
   * lancio (vedi `launch()`): se un file è mancante per anche un solo
   * destinatario, l'intera campagna non deve partire.
   */
  private async findMissingAttachments(
    campaign: Campaign,
  ): Promise<Array<{ recipientId: string; codiceFiscale: string; slotIndex: number; expectedFilename: string }>> {
    const attachmentsConfig = resolveAttachmentsConfig(campaign.channelConfig);
    if (attachmentsConfig.length === 0) return [];

    const dir = getUploadsDir(campaign.id);
    const present = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);

    const recipients = await this.recipientRepo.find({
      where: { campaignId: campaign.id, status: RecipientStatus.PENDING },
      select: ['id', 'codiceFiscale', 'extraData'],
    });

    const missing: Array<{ recipientId: string; codiceFiscale: string; slotIndex: number; expectedFilename: string }> = [];
    for (const r of recipients) {
      for (let index = 0; index < attachmentsConfig.length; index++) {
        const filename = resolveCustomAttachmentFilename(
          { campaign, extraData: r.extraData } as unknown as Recipient,
          index,
        );
        if (filename && !present.has(filename)) {
          missing.push({ recipientId: r.id, codiceFiscale: r.codiceFiscale, slotIndex: index, expectedFilename: filename });
        }
      }
    }
    return missing;
  }

  /**
   * Post-processing degli allegati caricati:
   * 1. estrae i PDF dagli eventuali .zip (appiattendo i path) e rimuove gli zip;
   * 2. elimina i PDF non referenziati da alcun destinatario (extraData/allegatoKey).
   * Safety: se NESSUN destinatario referenzia un allegato, non scarta nulla
   * (evita di svuotare la cartella in flussi senza mappatura allegato).
   */
  async finalizeAttachments(
    campaignId: string,
    files: Express.Multer.File[],
  ): Promise<{ uploaded: number; discarded: number }> {
    const dir = getUploadsDir(campaignId);
    fs.mkdirSync(dir, { recursive: true });

    // 1. Estrazione ZIP
    for (const file of files) {
      if (!file.originalname.toLowerCase().endsWith('.zip')) continue;
      await extractZipWithYauzl(file.path, dir);
      fs.unlinkSync(file.path);
    }

    // 2. Set dei filename referenziati dai destinatari
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    const recipients = await this.recipientRepo.find({
      where: { campaignId },
      select: ['extraData'],
    });
    const attachmentsConfig = resolveAttachmentsConfig(campaign.channelConfig);
    const totalSlots = Math.max(attachmentsConfig.length, 1); // almeno un tentativo per il fallback legacy
    const referenced = new Set<string>();
    for (const r of recipients) {
      for (let index = 0; index < totalSlots; index++) {
        const filename = resolveCustomAttachmentFilename({
          campaign,
          extraData: r.extraData,
        } as unknown as Recipient, index);
        if (filename) referenced.add(filename);
      }
    }

    // 3. Ridenominazione per case-insensitivity e scarto dei non referenziati
    const referencedLowerMap = new Map<string, string>();
    for (const ref of referenced) {
      referencedLowerMap.set(ref.toLowerCase(), ref);
    }

    let discarded = 0;
    const present = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    for (const f of present) {
      const expectedName = referencedLowerMap.get(f.toLowerCase());
      if (expectedName) {
        if (f !== expectedName) {
          fs.renameSync(join(dir, f), join(dir, expectedName));
        }
      } else {
        fs.unlinkSync(join(dir, f));
        discarded++;
      }
    }

    const uploaded = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
    return { uploaded, discarded };
  }

  async remove(campaignId: string): Promise<{ deleted: true }> {
    const exists = await this.campaignRepo.existsBy({ id: campaignId });
    if (!exists) throw new NotFoundException(`Campaign ${campaignId} not found`);

    await fs.promises.rm(getUploadsDir(campaignId), { recursive: true, force: true });
    await this.campaignRepo.delete(campaignId);

    return { deleted: true };
  }
}

