import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { parse } from 'csv-parse';
import * as fs from 'fs';
import { join } from 'path';
import { extractZipWithYauzl } from './zip-extract.util';
import { classifyChannelOutcome, type ChannelOutcome } from './channel-outcome.util';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import type { AppConfiguration } from '../config/configuration';
import { AppSettingsService } from '../settings/app-settings.service';
import { processTemplate, wrapInHtmlLayout, hasValidAttachmentPlaceholders, resolveCitizenPortalUrl, buildParallelChannelNotice, formatAppIoMarkdown } from '../channels/template.helper';
import { getEffectiveRetentionDays } from './retention.util';
import { getUploadsDir } from '../attachments/attachment-paths';
import { resolveAttachmentsConfig, resolveAttachmentLabel, resolveCustomAttachmentFilename } from '../attachments/attachment.service';
import { resolveSubjectTemplate } from '../channels/subject-mapping.util';
import { resolveExternalId } from '../channels/external-id-mapping.util';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { NOTIFICATION_JOB_SEND } from '../queue/notification-job.types';
import { NotificationQueuesService } from '../queue/notification-queues.service';
import { resolveSecondaryAppIoConfig } from '../channels/secondary-channels.util';
import { resolvePaymentData } from '../channels/payment-config.util';
import type { CreateCampaignDto } from './dto/create-campaign.dto';
import type { UpdateCampaignDto } from './dto/update-campaign.dto';
import type { UpdateCampaignContentDto } from './dto/update-campaign-content.dto';
import type { TestSendDto } from './dto/test-send.dto';
import type { CampaignStatsDto, RecipientStatDto, RecipientStatsPageDto, ChannelBreakdownDto, EffectiveChannelBreakdownDto, DownloadCombinationDto, DownloadCombinationStatsDto, FailureRowDto, FailureGroupDto, DownloadReportDto, SendStatusBreakdownDto, SendReportDto, SendReportRowDto, PostalStatusBreakdownDto, PostalReportDto, PostalReportRowDto, CampaignCostDto, CampaignCostSavingsDto, CampaignPaymentTotalDto } from './dto/campaign-stats.dto';
import type { GlobalStatsDto, NeverDownloadedRowDto } from './dto/global-stats.dto';
import { mergeMonthlyTrend, computeDownloadPercentage, buildDateRangeWhere } from './global-stats.util';
import type { PreviewMessageDto, PreviewMessageResult } from './dto/preview-message.dto';
import type { NotificationChannel, OperatorRole } from '@comunicapa/shared-types';
import { InadService } from '../channels/inad/inad.service';
import { PostalStatusSyncService } from '../channels/postal/postal-status-sync.service';

const INAD_BULK_THRESHOLD = 100;
// Sentinella filtro "Stato Consegna" per attempt SUCCESS senza send_status/postal_status
// ancora sincronizzato (stesso null gestito da ChannelStatusBar/pendingLabel "In corso"/
// "In attesa" in frontend) — stringa concordata a mano col frontend (App.tsx), non un
// valore reale mai emesso da PN/GlobalCom quindi nessuna collisione possibile.
const PENDING_DELIVERY_STATUS_SENTINEL = '__PENDING__';

export interface CampaignRequester {
  username: string;
  role: OperatorRole;
}

/**
 * SEND e POSTAL Servizio Agol (Atto Giudiziario) sono invii a valore legale:
 * calcolato a runtime da channelType/channelConfig, non richiede di tenere
 * isLegalValue sincronizzato ogni volta che channelConfig.postalServiceType
 * cambia durante il wizard. Blocca solo remove() (l'allegato/record è la
 * prova dell'invio) — cancel() resta permesso: serve a fermare destinatari
 * ancora in coda per errore, senza toccare quelli già notificati.
 */
export function isCampaignLegalValue(campaign: Pick<Campaign, 'isLegalValue' | 'channelType' | 'channelConfig'>): boolean {
  if (campaign.isLegalValue) return true;
  if (campaign.channelType === 'SEND') return true;
  if (campaign.channelType === 'POSTAL') {
    const servizio = String(campaign.channelConfig?.['postalServiceType'] ?? '');
    if (servizio.startsWith('Agol')) return true;
  }
  return false;
}

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  // Admin annulla/elimina qualunque campagna; un 'user' solo le proprie
  // (Campaign.createdBy) — vedi cancel()/remove().
  private assertOwnership(campaign: Campaign, requester: CampaignRequester): void {
    if (requester.role !== 'admin' && campaign.createdBy !== requester.username) {
      throw new ForbiddenException('Non puoi modificare una campagna creata da un altro operatore');
    }
  }

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
    private readonly postalStatusSync: PostalStatusSyncService,
  ) {}

  findAll(): Promise<Campaign[]> {
    return this.campaignRepo.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<Campaign> {
    const campaign = await this.campaignRepo.findOneBy({ id });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);
    return campaign;
  }

  /**
   * Data più vicina in cui la retention notturna eliminerà un allegato di
   * questa campagna (il primo a scadere, tra quelli non ancora eliminati) —
   * mostrata in dettaglio campagna per le campagne NON a valore legale
   * (quelle a valore legale non scadono mai, vedi retention-cleanup.service.ts).
   */
  async getAttachmentRetentionInfo(campaignId: string): Promise<{ earliestExpiryAt: string | null }> {
    const result = await this.recipientRepo
      .createQueryBuilder('r')
      .select('MIN(r.attachment_expires_at)', 'min')
      .where('r.campaign_id = :campaignId', { campaignId })
      .andWhere('r.attachment_deleted_at IS NULL')
      .andWhere('r.attachment_expires_at IS NOT NULL')
      .getRawOne();
    return { earliestExpiryAt: result?.min ? new Date(result.min).toISOString() : null };
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
    if (dto.isLegalValue !== undefined) campaign.isLegalValue = dto.isLegalValue;
    return this.campaignRepo.save(campaign);
  }

  /**
   * Corregge subject/body di una campagna già conclusa, storicizzando la
   * versione precedente in channelConfig.contentHistory. MERGE puntuale su
   * subject/body — mai un replace completo di channelConfig (a differenza di
   * updateDraft sopra), per non perdere le altre chiavi già presenti
   * (allegati, config canale, ecc.).
   */
  async updateCampaignContent(
    campaignId: string,
    dto: UpdateCampaignContentDto,
    changedBy: string,
  ): Promise<Campaign> {
    if (dto.subject === undefined && dto.body === undefined) {
      throw new BadRequestException('Specificare almeno subject o body da correggere');
    }
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    const terminal = [CampaignStatus.COMPLETED, CampaignStatus.FAILED, CampaignStatus.CANCELLED];
    if (!terminal.includes(campaign.status)) {
      throw new BadRequestException('Il contenuto si può correggere solo su una campagna già conclusa (completata, fallita o annullata)');
    }

    const cfg = campaign.channelConfig as Record<string, any>;
    const previousEntry = {
      subject: (cfg['subject'] as string) ?? null,
      body: (cfg['body'] as string) ?? null,
      changedBy,
      changedAt: new Date().toISOString(),
    };
    const history = Array.isArray(cfg['contentHistory']) ? cfg['contentHistory'] : [];

    campaign.channelConfig = {
      ...cfg,
      contentHistory: [...history, previousEntry],
      ...(dto.subject !== undefined ? { subject: dto.subject } : {}),
      ...(dto.body !== undefined ? { body: dto.body } : {}),
    };
    return this.campaignRepo.save(campaign);
  }

  async getDuplicateSource(id: string): Promise<{
    name: string;
    description: string | null;
    channelType: Campaign['channelType'];
    channelConfig: Record<string, unknown>;
    isLegalValue: boolean;
  }> {
    const campaign = await this.campaignRepo.findOneBy({ id });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);
    return {
      name: campaign.name,
      description: campaign.description,
      channelType: campaign.channelType,
      channelConfig: campaign.channelConfig,
      isLegalValue: campaign.isLegalValue,
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
    let previewRecipientId: string = randomUUID();
    if (dto.campaignId && dto.recipient?.codiceFiscale) {
      const realRecipient = await this.recipientRepo.findOne({
        where: {
          campaignId: dto.campaignId,
          codiceFiscale: dto.recipient.codiceFiscale.toUpperCase().trim(),
        },
      });
      if (realRecipient) {
        previewRecipientId = realRecipient.id;
      }
    }

    const previewRecipient = {
      id: previewRecipientId,
      codiceFiscale: dto.recipient?.codiceFiscale?.trim() || 'TSTMRA80A01H501U',
      fullName: dto.recipient?.fullName ?? null,
      email: dto.recipient?.email ?? null,
      pec: dto.recipient?.pec ?? null,
      extraData: dto.recipient?.extraData ?? {},
      protocolNumber: dto.recipient?.protocolNumber ?? null,
    } as unknown as Recipient;

    const attachmentLabels = (dto.attachments ?? []).map((a) => resolveAttachmentLabel({ key: a.key ?? '', label: a.label ?? '', labelColumn: a.labelColumn }, previewRecipient));
    return this.renderMessage(
      dto.channelType,
      dto.subject,
      dto.body,
      attachmentLabels,
      previewRecipient,
      dto.format,
      undefined,
      true,
      dto.appIoParallelPrimaryChannel,
      dto.physicalAddressConfig,
    );
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
      | { subjectOverride?: string; bodyOverride?: string; mode?: 'parallel' | 'exclusive' }
      | undefined;
    if (!appIoConfig) return null;

    const subjectTemplate = appIoConfig.subjectOverride || (campaign.channelConfig?.['subject'] as string) || campaign.name;
    const bodyTemplate = appIoConfig.bodyOverride || (campaign.channelConfig?.['body'] as string) || '';
    const attachmentLabels = resolveAttachmentsConfig(campaign.channelConfig).map((a) => resolveAttachmentLabel(a, recipient));

    // Cortesia canale primario solo per co-consegna PARALLELA — in esclusiva
    // il canale primario non viene inviato, nessun canale da annunciare.
    const parallelPrimaryChannel = appIoConfig.mode === 'parallel' ? campaign.channelType : undefined;
    const physicalAddressConfig = campaign.channelConfig?.['physicalAddressConfig'] as Record<string, unknown> | undefined;

    return this.renderMessage('APP_IO', subjectTemplate, bodyTemplate, attachmentLabels, recipient, 'markdown', undefined, true, parallelPrimaryChannel, physicalAddressConfig);
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
    appIoParallelPrimaryChannel?: NotificationChannel,
    physicalAddressConfig?: Record<string, unknown>,
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

    const portalUrl = await resolveCitizenPortalUrl(this.settings);

    if (resolvedFormat === 'markdown') {
      const parallelNotice = appIoParallelPrimaryChannel
        ? buildParallelChannelNotice(recipientLike, appIoParallelPrimaryChannel, physicalAddressConfig)
        : undefined;
      return { subject, bodyMarkdown: formatAppIoMarkdown(body, { parallelNotice, portalUrl }) };
    }

    const brandLogo = await this.settings.get<string>('brand.logo');
    const logoUrl = brandLogo ? (/^https?:\/\//i.test(brandLogo) ? brandLogo : `${publicApiUrl}/branding/logo`) : null;
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
      isLegalValue: dto.isLegalValue ?? false,
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

  private assertSendProtocolConfigured(campaign: Campaign): void {
    const isAgolPostal = campaign.channelType === 'POSTAL'
      && String(campaign.channelConfig?.['postalServiceType'] ?? '').startsWith('Agol');
    if ((campaign.channelType === 'SEND' || isAgolPostal) && campaign.channelConfig?.['protocolla'] !== true) {
      const label = campaign.channelType === 'SEND' ? 'SEND' : 'Atto Giudiziario (POSTAL Agol*)';
      throw new BadRequestException(
        `Protocollazione obbligatoria per ${label}: channelConfig.protocolla deve essere true`,
      );
    }
  }

  private async checkAttachmentsBlocking(campaign: Campaign): Promise<{ blocked: true; message: string } | null> {
    // SEND (atto legale) e POSTAL (lettera cartacea) senza nessun allegato
    // configurato invierebbero un PDF segnaposto generico come unico
    // documento notificato — non un caso d'uso reale, blocca a monte.
    if (
      (campaign.channelType === 'SEND' || campaign.channelType === 'POSTAL') &&
      resolveAttachmentsConfig(campaign.channelConfig).length === 0
    ) {
      // Il passo del wizard dove si configurano gli allegati differisce fra
      // invio massivo (Passo 3, mappatura CSV) e invio singolo (Passo 1,
      // destinatario+allegato fusi) — channelConfig.wizSingleMode lo indica
      // (persistito da buildWizChannelConfigDraft). Un messaggio che cita
      // sempre "Passo 3" è formalmente sbagliato in invio singolo.
      const step = campaign.channelConfig?.['wizSingleMode'] ? '1' : '3';
      return {
        blocked: true,
        message: `Impossibile avviare: allegato obbligatorio per il canale ${campaign.channelType}. Configuralo al Passo ${step} prima di rilanciare.`,
      };
    }

    const missingAttachments = await this.findMissingAttachments(campaign);
    if (missingAttachments.length > 0) {
      const sample = missingAttachments
        .slice(0, 5)
        .map((m) => `${m.expectedFilename} (CF ${m.codiceFiscale})`)
        .join(', ');
      const more = missingAttachments.length > 5 ? ', …' : '';

      const dir = getUploadsDir(campaign.id);
      const presentFiles = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      const presentList =
        presentFiles.length > 0
          ? presentFiles.slice(0, 10).join(', ') + (presentFiles.length > 10 ? '...' : '')
          : 'nessuno';

      // Risposta 200 (non BadRequestException): il reverse proxy di produzione
      // intercetta le risposte non-2xx e ne sostituisce il body con una pagina
      // HTML propria, rendendo illeggibile il messaggio lato frontend — stesso
      // problema già risolto altrove (vedi io-services.service.ts `test()`).
      return {
        blocked: true,
        message: `Impossibile avviare: ${missingAttachments.length} allegato/i mancante/i rispetto alla mappatura configurata — es. ${sample}${more}. Carica i file mancanti prima di rilanciare. (Presenti in cartella: ${presentList})`,
      };
    }

    const attachmentCount = resolveAttachmentsConfig(campaign.channelConfig).length;

    if (
      ['EMAIL', 'PEC', 'APP_IO'].includes(campaign.channelType) &&
      !hasValidAttachmentPlaceholders((campaign.channelConfig?.['body'] as string) || '', attachmentCount)
    ) {
      return {
        blocked: true,
        message: `Impossibile avviare: il template non contiene il blocco "Elenco Allegati" (%%elenco_allegati%%) né tutti i link singoli (%%allegato1%%...%%allegato${attachmentCount}%%) per i ${attachmentCount} allegati configurati. Aggiungi il placeholder al Passo 4 prima di rilanciare.`,
      };
    }

    const appIoConfig = resolveSecondaryAppIoConfig(campaign.channelConfig) as { bodyOverride?: string } | undefined;
    if (
      appIoConfig?.bodyOverride &&
      !hasValidAttachmentPlaceholders(appIoConfig.bodyOverride, attachmentCount)
    ) {
      return {
        blocked: true,
        message: `Impossibile avviare: il testo App IO differenziato non contiene il blocco "Elenco Allegati" né tutti i link singoli per i ${attachmentCount} allegati configurati. Correggilo al Passo 4 prima di rilanciare.`,
      };
    }

    return null;
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
    try {
      this.assertSendProtocolConfigured(campaign);
    } catch (err) {
      await this.campaignRepo.update({ id: campaignId }, { status: CampaignStatus.DRAFT });
      throw err;
    }

    const attachmentsBlock = await this.checkAttachmentsBlocking(campaign);
    if (attachmentsBlock) {
      await this.campaignRepo.update({ id: campaignId }, { status: CampaignStatus.DRAFT });
      return { launched: 0, campaignId, ...attachmentsBlock };
    }

    const recipients = await this.recipientRepo.find({
      where: { campaignId, status: RecipientStatus.PENDING },
      select: ['id'],
    });

    if (recipients.length === 0) {
      throw new BadRequestException('No pending recipients — upload a CSV first');
    }

    let channelOverrides: Map<string, NotificationChannel> | undefined;
    // Wizard singolo: l'operatore verifica il domicilio digitale a mano (step1,
    // "Carica dati ANPR") e sceglie il canale di conseguenza — nessun check
    // INAD automatico "a sorpresa" al lancio come per le campagne massive
    // (channelConfig.wizSingleMode è impostato dal wizard, mai dall'utente CSV).
    const isWizSingleMode = campaign.channelConfig?.['wizSingleMode'] === true;
    const inadCheckEnabled =
      !isWizSingleMode &&
      campaign.channelType !== 'SEND' &&
      (await this.settings.get<boolean>('inad.checkEnabled'));
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

  async launchTestSend(
    parentCampaignId: string,
    dto: TestSendDto,
  ): Promise<{ attemptId: string; testCampaignId: string; blocked?: boolean; message?: string }> {
    const parent = await this.campaignRepo.findOneBy({ id: parentCampaignId });
    if (!parent) throw new NotFoundException(`Campaign ${parentCampaignId} not found`);

    this.assertSendProtocolConfigured(parent);

    let child = await this.campaignRepo.findOneBy({ parentCampaignId, isTest: true });
    if (!child) {
      const created = this.campaignRepo.create({
        name: `[TEST] ${parent.name}`,
        channelType: parent.channelType,
        channelConfig: parent.channelConfig,
        status: CampaignStatus.QUEUED,
        createdBy: parent.createdBy,
        isTest: true,
        parentCampaignId,
      });
      child = await this.campaignRepo.save(created);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- _QueryDeepPartialEntity non gestisce bene un
      // index signature generico (Record<string, unknown>) su colonna jsonb, stesso limite noto di TypeORM 0.3.x.
      await this.campaignRepo.update({ id: child.id }, { channelConfig: parent.channelConfig as any });
      child = { ...child, channelConfig: parent.channelConfig };
    }

    // Copia fisica isolata: la campagna test non deve mai riferire i file
    // della madre, altrimenti la sua retention/cancellazione rischierebbe
    // di cancellare allegati ancora necessari alla bozza madre non lanciata.
    const parentDir = getUploadsDir(parentCampaignId);
    const childDir = getUploadsDir(child.id);
    if (fs.existsSync(parentDir)) {
      fs.rmSync(childDir, { recursive: true, force: true });
      fs.mkdirSync(childDir, { recursive: true });
      fs.cpSync(parentDir, childDir, { recursive: true });
    }

    // Il destinatario di prova va creato PRIMA del controllo allegati:
    // findMissingAttachments() pesca solo i recipient PENDING della campagna
    // figlia — al primo invio di prova non ce n'è ancora nessuno (il check
    // sarebbe sempre no-op), ai successivi l'unico eventuale PENDING è
    // proprio quello appena creato (i precedenti sono già QUEUED dopo
    // createAttemptsAndEnqueue). Creandolo prima, il check valida
    // esattamente il file atteso per QUESTO CF di test.
    const recipient = this.recipientRepo.create({
      campaignId: child.id,
      codiceFiscale: dto.codiceFiscale,
      email: dto.email ?? null,
      pec: dto.pec ?? null,
      fullName: dto.extraData['full_name'] ?? null,
      extraData: dto.extraData,
      status: RecipientStatus.PENDING,
    });
    const savedRecipient = await this.recipientRepo.save(recipient);

    const attachmentsBlock = await this.checkAttachmentsBlocking(child);
    if (attachmentsBlock) {
      // Elimina il recipient appena creato: coerente col pattern di `launch()`
      // (che riporta la campagna a DRAFT su blocco) — nessuna riga PENDING
      // orfana che non verrà mai processata, la campagna figlia resta pulita
      // per un successivo tentativo di test-send.
      await this.recipientRepo.delete({ id: savedRecipient.id });
      return { attemptId: '', testCampaignId: child.id, ...attachmentsBlock };
    }

    // Stessa logica INAD del lancio reale (launch()): il test deve rispecchiare
    // esattamente cosa succederebbe al destinatario nella campagna vera, non un
    // percorso semplificato — altrimenti un test "riuscito" mostra un canale
    // (es. POSTAL) che nella campagna reale verrebbe dirottato a PEC da INAD.
    // Un solo destinatario di prova: mai sopra INAD_BULK_THRESHOLD, nessun ramo
    // bulk-batch da gestire qui.
    const isWizSingleMode = child.channelConfig?.['wizSingleMode'] === true;
    const inadCheckEnabled =
      !isWizSingleMode &&
      child.channelType !== 'SEND' &&
      (await this.settings.get<boolean>('inad.checkEnabled'));
    const channelOverrides = inadCheckEnabled
      ? await this.runInadExtractLoop(child, [{ id: savedRecipient.id }])
      : undefined;

    const { launched } = await this.createAttemptsAndEnqueue(child, [{ id: savedRecipient.id }], channelOverrides);
    if (launched === 0) {
      throw new BadRequestException('Invio di prova non accodato');
    }

    const attempt = await this.attemptRepo.findOne({
      where: { recipientId: savedRecipient.id },
      order: { createdAt: 'DESC' },
    });

    return { attemptId: attempt!.id, testCampaignId: child.id };
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
          const diverted = found && inadAddress !== recipient.pec;
          await this.recipientRepo.update(
            { id: recipient.id },
            {
              inadCheck: {
                found,
                diverted,
                originalChannel: campaign.channelType,
                originalAddress: campaign.channelType === 'PEC' ? recipient.pec : recipient.email,
                checkedAt: new Date().toISOString(),
              },
              ...(diverted ? { pec: inadAddress } : {}),
            },
          );
          if (diverted) {
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
        const diverted = found && inadAddress !== recipient.pec;
        await this.recipientRepo.update(
          { id: recipient.id },
          {
            inadCheck: {
              found,
              diverted,
              originalChannel: campaign.channelType,
              originalAddress: campaign.channelType === 'PEC' ? recipient.pec : recipient.email,
              checkedAt: new Date().toISOString(),
            },
            ...(diverted ? { pec: inadAddress } : {}),
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
        if (r.inadCheck?.diverted && campaign.channelType !== 'PEC') {
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

  async getInadCheckStatus(campaignId: string): Promise<{
    requestedAt: string | null;
    totalBatches: number;
    completedBatches: number;
    batches: Array<{
      id: string;
      recipientCount: number;
      done: boolean;
      state: string | null;
      error: string | null;
    }>;
  }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const inadCheck = campaign.channelConfig?.['inadCheck'] as
      | { mechanism: 'bulk'; batches: Array<{ id: string; recipientIds: string[]; done: boolean }>; requestedAt?: string }
      | undefined;

    if (!inadCheck || !Array.isArray(inadCheck.batches)) {
      return { requestedAt: null, totalBatches: 0, completedBatches: 0, batches: [] };
    }

    const batchStatuses = await Promise.all(
      inadCheck.batches.map(async (b) => {
        let state: string | null = null;
        let error: string | null = null;
        if (b.done) {
          state = 'DISPONIBILE';
        } else {
          try {
            state = await this.inadService.getBulkState(b.id);
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
          }
        }
        return {
          id: b.id,
          recipientCount: b.recipientIds?.length ?? 0,
          done: b.done,
          state,
          error,
        };
      }),
    );

    const completedBatches = batchStatuses.filter((b) => b.done || b.state === 'DISPONIBILE').length;

    return {
      requestedAt: inadCheck.requestedAt ?? null,
      totalBatches: inadCheck.batches.length,
      completedBatches,
      batches: batchStatuses,
    };
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

  async cancel(campaignId: string, requester: CampaignRequester): Promise<{ cancelled: number; campaignId: string }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    this.assertOwnership(campaign, requester);
    if (
      campaign.status !== CampaignStatus.QUEUED &&
      campaign.status !== CampaignStatus.CHECKING_INAD &&
      campaign.status !== CampaignStatus.RUNNING
    ) {
      throw new BadRequestException('Solo campagne in corso o in verifica INAD possono essere annullate');
    }

    const cancelableRecipients = await this.recipientRepo.find({
      where: { campaignId, status: In([RecipientStatus.QUEUED, RecipientStatus.PENDING]) },
      select: ['id', 'extraData', 'status'],
    });
    const cancelableById = new Map(cancelableRecipients.map((r) => [r.id, r]));

    let cancelled = 0;
    if (cancelableRecipients.length > 0) {
      const queuedRecipients = cancelableRecipients.filter((r) => r.status !== RecipientStatus.PENDING);
      const pendingRecipients = cancelableRecipients.filter((r) => r.status === RecipientStatus.PENDING);

      let removedRecipientIds: string[] = [];

      if (queuedRecipients.length > 0) {
        const queuedRecipientIds = queuedRecipients.map((r) => r.id);
        const liveAttempts = await this.attemptRepo.find({
          where: { recipientId: In(queuedRecipientIds), status: AttemptStatus.QUEUED },
        });

        if (campaign.channelType === 'SEND') {
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
            const removedAttemptIds = (updateResult.raw as Array<{ id: string }>).map((row) => row.id);
            const queuedCancelledRecipientIds = removedAttemptIds.map((id) => recipientByAttemptId.get(id)!);
            removedRecipientIds.push(...queuedCancelledRecipientIds);

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
          const removedAttemptIds: string[] = [];
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
      }

      if (pendingRecipients.length > 0) {
        const pendingIds = pendingRecipients.map((r) => r.id);
        removedRecipientIds.push(...pendingIds);
      }

      // Deduplica gli ID per sicurezza
      removedRecipientIds = Array.from(new Set(removedRecipientIds));

      if (removedRecipientIds.length > 0) {
        await this.recipientRepo.update({ id: In(removedRecipientIds) }, { status: RecipientStatus.CANCELLED });

        // Il destinatario cancellato non riceverà mai la notifica: l'allegato
        // personalizzato non serve più (non c'è download da servire), elimina
        // subito invece di aspettare la scadenza retention.
        const attachmentsConfig = resolveAttachmentsConfig(campaign.channelConfig);
        const totalSlots = Math.max(attachmentsConfig.length, 1);
        const dir = getUploadsDir(campaignId);
        for (const recipientId of removedRecipientIds) {
          const recipient = cancelableById.get(recipientId);
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
        statuses: [CampaignStatus.QUEUED, CampaignStatus.CHECKING_INAD, CampaignStatus.RUNNING],
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
   * NON vive solo sul primo tentativo: retryRecipient() crea un nuovo attempt
   * con un nuovo jobId per ogni retry (es. correzione indirizzo POSTAL), e
   * job.attemptsMade riparte da 0 su quel job — la co-delivery può quindi
   * rifirmare (o riuscire per la prima volta) su un attempt successivo al
   * primo (bug reale corretto: un successo App IO visibile sull'attempt 2 in
   * "Dettaglio Notifica" non veniva mai contato qui, che leggeva solo
   * attemptNumber=1 — sottostimava sistematicamente "Anche App IO
   * (parallela)"). Aggreghiamo quindi su TUTTI gli attempt del destinatario;
   * lo stato primario resta quello ATTUALE del destinatario (aggiornato
   * anche dai retry).
   */
  async getChannelBreakdown(campaignId: string): Promise<ChannelBreakdownDto | null> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipients = await this.recipientRepo.find({
      where: { campaignId },
      select: ['id', 'status', 'inadCheck'],
    });

    const hasAppIo = !!resolveSecondaryAppIoConfig(campaign.channelConfig);
    // inadDiverted conta TUTTI i destinatari con un dirottamento INAD reale
    // (diverted:true), indipendentemente dallo stato — descrive una decisione
    // di instradamento presa al lancio, non un esito di invio, quindi include
    // anche i destinatari ancora PENDING (check bulk non ancora finalizzato).
    const inadDiverted = recipients.filter((r) => r.inadCheck?.diverted).length;
    if (!hasAppIo && inadDiverted === 0) return null;

    const breakdown: ChannelBreakdownDto = { primaryOnly: 0, both: 0, appIoOnly: 0, appIoDespitePrimaryFail: 0, neither: 0, inadDiverted };
    const toClassify = recipients.filter(
      (r) => r.status === RecipientStatus.SENT || r.status === RecipientStatus.FAILED,
    );
    if (toClassify.length === 0) return breakdown;

    const payloadByRecipient = await this.buildAggregatedAppIoPayloads(toClassify.map((r) => r.id));

    for (const r of toClassify) {
      const payload = payloadByRecipient.get(r.id);
      const outcome = classifyChannelOutcome(r.status, payload);
      if (outcome) breakdown[outcome]++;
    }
    return breakdown;
  }

  /**
   * Un destinatario può avere App IO riuscito su un attempt qualsiasi, non
   * solo il primo (vedi commento getChannelBreakdown sopra) — riduce TUTTI
   * gli attempt di ogni destinatario in un unico responsePayload aggregato:
   * `appIo.success` true se un QUALSIASI attempt ha avuto successo App IO,
   * `deliveredVia` 'APP_IO' se un QUALSIASI attempt ha consegnato in
   * esclusiva. Condiviso da getChannelBreakdown/getRecipientIdsByChannelOutcome
   * per restare coerenti tra loro.
   */
  private async buildAggregatedAppIoPayloads(recipientIds: string[]): Promise<Map<string, Record<string, unknown>>> {
    const allAttempts = await this.attemptRepo.find({
      where: { recipientId: In(recipientIds) },
      select: ['recipientId', 'responsePayload'],
    });
    const payloadByRecipient = new Map<string, Record<string, unknown>>();
    for (const a of allAttempts) {
      const appIo = a.responsePayload?.['appIo'] as { success?: boolean } | undefined;
      const deliveredViaAppIo = a.responsePayload?.['deliveredVia'] === 'APP_IO';
      if (!appIo?.success && !deliveredViaAppIo) continue;
      const existing = payloadByRecipient.get(a.recipientId) ?? {};
      if (appIo?.success) existing.appIo = { success: true };
      if (deliveredViaAppIo) existing.deliveredVia = 'APP_IO';
      payloadByRecipient.set(a.recipientId, existing);
    }
    return payloadByRecipient;
  }

  async getRecipientIdsByChannelOutcome(campaignId: string, outcome: ChannelOutcome): Promise<string[]> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipients = await this.recipientRepo.find({
      where: { campaignId },
      select: ['id', 'status'],
    });
    const toClassify = recipients.filter(
      (r) => r.status === RecipientStatus.SENT || r.status === RecipientStatus.FAILED,
    );
    if (toClassify.length === 0) return [];

    const payloadByRecipient = await this.buildAggregatedAppIoPayloads(toClassify.map((r) => r.id));

    return toClassify
      .filter((r) => classifyChannelOutcome(r.status, payloadByRecipient.get(r.id)) === outcome)
      .map((r) => r.id);
  }

  /**
   * Canale effettivo di consegna per i destinatari notificati con successo
   * (SENT), a prescindere dal canale di campagna: unifica i due meccanismi
   * di dirottamento esistenti (App IO esclusiva a runtime via
   * responsePayload.deliveredVia, override INAD già scritto in
   * attempt.channelType al momento della creazione dell'attempt) in un'unica
   * vista "chi ha ricevuto cosa dove". Bucket mutuamente esclusivi: se App IO
   * ha consegnato in esclusiva vince APP_IO, altrimenti il canale è quello
   * dell'attempt (che è già PEC se INAD ha dirottato quel destinatario).
   */
  async getEffectiveChannelBreakdown(campaignId: string): Promise<EffectiveChannelBreakdownDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const sentRecipients = await this.recipientRepo.find({
      where: { campaignId, status: RecipientStatus.SENT },
      select: ['id'],
    });
    if (sentRecipients.length === 0) return {};

    const firstAttempts = await this.attemptRepo.find({
      where: { recipientId: In(sentRecipients.map((r) => r.id)), attemptNumber: 1 },
      select: ['recipientId', 'channelType', 'responsePayload'],
    });

    // Raggruppa i canali effettivi per destinatario: un destinatario con co-delivery
    // parallela (PEC + App IO entrambi con attemptNumber=1) deve produrre UNA sola
    // voce combinata (es. "APP_IO + PEC"), non due voci separate.
    const channelsByRecipient = new Map<string, Set<string>>();
    for (const attempt of firstAttempts) {
      const deliveredViaAppIo = attempt.responsePayload?.['deliveredVia'] === 'APP_IO';
      const effectiveChannel = deliveredViaAppIo ? 'APP_IO' : attempt.channelType;
      if (!channelsByRecipient.has(attempt.recipientId)) {
        channelsByRecipient.set(attempt.recipientId, new Set());
      }
      channelsByRecipient.get(attempt.recipientId)!.add(effectiveChannel);
    }

    const breakdown: Record<string, number> = {};
    for (const channels of channelsByRecipient.values()) {
      const key = [...channels].sort().join(' + ');
      breakdown[key] = (breakdown[key] ?? 0) + 1;
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

    const recipients = await this.recipientRepo.find({ where: { campaignId }, select: ['id'] });
    if (recipients.length === 0) {
      return { queued: 0, protocollato: 0, inviato: 0, fallito: 0 };
    }

    const recipientIds = recipients.map((r) => r.id);
    const attempts = await this.attemptRepo.find({
      where: { recipientId: In(recipientIds) },
      select: ['recipientId', 'attemptNumber', 'status', 'protocolledAt'],
    });

    const latestByRecipient = new Map<string, NotificationAttempt>();
    for (const a of attempts) {
      const current = latestByRecipient.get(a.recipientId);
      if (!current || a.attemptNumber > current.attemptNumber) {
        latestByRecipient.set(a.recipientId, a);
      }
    }

    let queued = 0;
    let protocollato = 0;
    let inviato = 0;
    let fallito = 0;

    for (const r of recipients) {
      const latest = latestByRecipient.get(r.id);
      if (!latest) {
        queued += 1;
      } else if (latest.status === AttemptStatus.FAILED) {
        fallito += 1;
      } else if (latest.status === AttemptStatus.SUCCESS) {
        inviato += 1;
      } else if (latest.status === AttemptStatus.QUEUED && latest.protocolledAt) {
        protocollato += 1;
      } else {
        queued += 1;
      }
    }

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
   *
   * POSTAL, ulteriore distinzione (bug reale corretto: il grafico marcava
   * "non scaricato" anche i destinatari con SOLA lettera cartacea, senza
   * alcuna co-consegna digitale — fuorviante, per definizione non hanno mai
   * avuto nulla da scaricare, non è un mancato download). Un destinatario
   * POSTAL ha un'opzione di download reale solo se: App IO parallela/
   * esclusiva riuscita (su un attempt qualsiasi, non solo il primo — vedi
   * buildAggregatedAppIoPayloads), oppure dirottato INAD su PEC
   * (`inadCheck.diverted`, notifica realmente digitale). Un destinatario
   * POSTAL "puro" (nessuna delle due) viene escluso da sentCount/
   * combinations — se però un DownloadEvent esiste comunque per lui (es.
   * portale cittadino raggiunto con CF nonostante nessun link fosse mai
   * stato notificato), viene contato separatamente in
   * `postalNoDigitalDownloaded`, mai perso silenziosamente.
   */
  async getDownloadCombinationStats(campaignId: string): Promise<DownloadCombinationStatsDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipients = await this.recipientRepo.find({ where: { campaignId }, select: ['id', 'status', 'inadCheck'] });
    if (recipients.length === 0) return { sentCount: 0, combinations: [], postalNoDigitalDownloaded: 0 };

    const isPostal = campaign.channelType === 'POSTAL';
    const appIoSuccessByRecipient = new Map<string, boolean>();
    if (resolveSecondaryAppIoConfig(campaign.channelConfig)) {
      const payloadByRecipient = await this.buildAggregatedAppIoPayloads(recipients.map((r) => r.id));
      for (const [recipientId, payload] of payloadByRecipient) {
        if ((payload['appIo'] as { success?: boolean } | undefined)?.success) {
          appIoSuccessByRecipient.set(recipientId, true);
        }
      }
    }
    const wasNotified = (r: { id: string; status: RecipientStatus }) =>
      r.status === RecipientStatus.SENT || appIoSuccessByRecipient.get(r.id) === true;
    // Non-POSTAL: ogni canale primario (EMAIL/PEC/APP_IO/SEND) è di per sé
    // digitale, sempre un'opzione di download reale se notificato.
    const hasDigitalOption = (r: { id: string; inadCheck: Recipient['inadCheck'] }) =>
      !isPostal || appIoSuccessByRecipient.get(r.id) === true || r.inadCheck?.diverted === true;

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
    let postalNoDigitalDownloaded = 0;
    for (const recipient of recipients) {
      const notified = wasNotified(recipient);
      const channels = channelsByRecipient.get(recipient.id);

      if (notified && !hasDigitalOption(recipient)) {
        // POSTAL puro (nessuna co-consegna digitale): non ha mai avuto un
        // link da scaricare, escluso dal denominatore. Se però risulta un
        // download reale comunque, va segnalato come anomalia a parte.
        if (channels && channels.size > 0) postalNoDigitalDownloaded += 1;
        continue;
      }

      if (notified) sentCount++;

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
    return { sentCount, combinations, postalNoDigitalDownloaded };
  }

  async getGlobalStats(dateFrom?: string, dateTo?: string): Promise<GlobalStatsDto> {
    const range = buildDateRangeWhere('c', dateFrom, dateTo);

    const totalsRow = await this.campaignRepo
      .createQueryBuilder('c')
      .select('COALESCE(SUM(c.totalRecipients), 0)', 'totalRecipients')
      .addSelect('COALESCE(SUM(c.sentCount), 0)', 'totalSent')
      .addSelect('COALESCE(SUM(c.failedCount), 0)', 'totalFailed')
      .where(range.sql, range.params)
      .andWhere('c.isTest = false')
      .getRawOne<{ totalRecipients: string; totalSent: string; totalFailed: string }>();

    const totalDownloaded = await this.recipientRepo
      .createQueryBuilder('r')
      .innerJoin('r.campaign', 'c')
      .where('r.downloadCount > 0')
      .andWhere(range.sql, range.params)
      .andWhere('c.isTest = false')
      .getCount();

    const sentTrendRows = await this.campaignRepo
      .createQueryBuilder('c')
      .select("to_char(date_trunc('month', c.createdAt), 'YYYY-MM')", 'month')
      .addSelect('COALESCE(SUM(c.sentCount), 0)', 'sent')
      .where(range.sql, range.params)
      .andWhere('c.isTest = false')
      .groupBy("date_trunc('month', c.createdAt)")
      .orderBy("date_trunc('month', c.createdAt)", 'ASC')
      .getRawMany<{ month: string; sent: string }>();

    const dailyTrendRows = await this.campaignRepo
      .createQueryBuilder('c')
      .select("to_char(date_trunc('day', c.createdAt), 'YYYY-MM-DD')", 'date')
      .addSelect('COALESCE(SUM(c.sentCount), 0)', 'sent')
      .addSelect('COALESCE(SUM(c.failedCount), 0)', 'failed')
      .where(range.sql, range.params)
      .andWhere('c.isTest = false')
      .groupBy("date_trunc('day', c.createdAt)")
      .orderBy("date_trunc('day', c.createdAt)", 'ASC')
      .getRawMany<{ date: string; sent: string; failed: string }>();

    const downloadedTrendRows = await this.recipientRepo
      .createQueryBuilder('r')
      .innerJoin('r.campaign', 'c')
      .select("to_char(date_trunc('month', c.createdAt), 'YYYY-MM')", 'month')
      .addSelect('COUNT(*) FILTER (WHERE r.downloadCount > 0)', 'downloaded')
      .where(range.sql, range.params)
      .andWhere('c.isTest = false')
      .groupBy("date_trunc('month', c.createdAt)")
      .getRawMany<{ month: string; downloaded: string }>();

    const channelRows = await this.campaignRepo
      .createQueryBuilder('c')
      .select('c.channelType', 'channel')
      .addSelect('COALESCE(SUM(c.sentCount), 0)', 'sent')
      .where(range.sql, range.params)
      .andWhere('c.isTest = false')
      .groupBy('c.channelType')
      .getRawMany<{ channel: string; sent: string }>();

    const downloadChannelRows = await this.downloadEventRepo
      .createQueryBuilder('de')
      .innerJoin('de.recipient', 'r')
      .innerJoin('r.campaign', 'c')
      .select('de.channel', 'channel')
      .addSelect('COUNT(*)', 'count')
      .where(range.sql, range.params)
      .andWhere('c.isTest = false')
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
      .andWhere('c.isTest = false')
      .groupBy('c.id')
      .getRawMany<{ campaignId: string; campaignName: string; totalRecipients: string; downloadedCount: string }>();

    const neverDownloadedCount = await this.recipientRepo
      .createQueryBuilder('r')
      .innerJoin('r.campaign', 'c')
      .where('r.downloadCount = 0')
      .andWhere('r.status = :status', { status: RecipientStatus.SENT })
      .andWhere(range.sql, range.params)
      .andWhere('c.isTest = false')
      .getCount();

    const costRow = await this.attemptRepo
      .createQueryBuilder('a')
      .innerJoin('a.recipient', 'r')
      .innerJoin('r.campaign', 'c')
      .select('COALESCE(SUM(a.costCents), 0)', 'totalCostCents')
      .where('a.channelType IN (:...channels)', { channels: ['SEND', 'POSTAL'] })
      .andWhere('a.costCents IS NOT NULL')
      .andWhere(range.sql, range.params)
      .andWhere('c.isTest = false')
      .getRawOne<{ totalCostCents: string }>();

    const savingRow = await this.recipientRepo
      .createQueryBuilder('r')
      .innerJoin('r.campaign', 'c')
      .leftJoin('r.attempts', 'a', "a.channel_type = 'SEND'")
      .select('c.id', 'campaignId')
      .addSelect('COALESCE(SUM(a.costCents), 0)', 'actualCostCents')
      .addSelect('COUNT(DISTINCT r.id)', 'recipientCount')
      .where("c.channelType = 'SEND'")
      .andWhere(range.sql, range.params)
      .andWhere('c.isTest = false')
      .groupBy('c.id')
      .getRawMany<{ campaignId: string; actualCostCents: string; recipientCount: string }>();

    const nominalBaseFeeCents = await this.settings.get<number>('send.digitalBaseFeeCents');
    const totalSavingCents = savingRow.reduce((sum, row) => {
      const nominal = nominalBaseFeeCents * Number(row.recipientCount);
      const saving = nominal - Number(row.actualCostCents);
      return saving > 0 ? sum + saving : sum;
    }, 0);

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
        totalCostCents: Number(costRow?.totalCostCents ?? 0),
        totalSavingCents,
      },
      monthlyTrend: mergeMonthlyTrend(sentTrendRows, downloadedTrendRows),
      dailyTrend: dailyTrendRows.map((r) => ({ date: r.date, sent: Number(r.sent), failed: Number(r.failed) })),
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

  /**
   * Elenco recipientId FAILED per un motivo di errore, risolto interamente
   * lato server — mai chiesto al browser di rimandare indietro l'array (bug
   * reale: POST retry-bulk con migliaia di UUID nel body superava il limite
   * default 100kb del body-parser Express, "PayloadTooLargeError" su un
   * batch TARI da 20100 destinatari). Stessa chiave sentinella
   * ("Errore sconosciuto") già usata in getFailuresByReason, per restare
   * coerente con l'etichetta di gruppo mostrata in UI.
   */
  async getFailedRecipientIdsByReason(campaignId: string, errorMessage: string): Promise<string[]> {
    const failures = await this.getFailures(campaignId);
    return failures
      .filter((f) => (f.errorMessage ?? 'Errore sconosciuto') === errorMessage)
      .map((f) => f.recipientId);
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

    // Il canale effettivo del destinatario può divergere da campaign.channelType
    // se l'ultimo tentativo era stato overridden (es. domicilio INAD trovato →
    // PEC su una campagna EMAIL) — il retry deve rispettare quel canale, non
    // tornare silenziosamente al canale di campagna (bug reale: un retry
    // ripristinava EMAIL su un destinatario che INAD aveva dirottato su PEC).
    const effectiveChannel = (lastAttempt?.channelType as NotificationChannel | undefined) ?? campaign.channelType;

    const result = await this.attemptRepo
      .createQueryBuilder()
      .insert()
      .into(NotificationAttempt)
      .values({
        recipientId,
        channelType: effectiveChannel,
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

    // Bug reale segnalato dal vivo: una campagna COMPLETED/FAILED (marcata
    // tale perché a quel momento nessun destinatario era più PENDING/QUEUED)
    // che riceve un retry (singolo o bulk) torna ad avere destinatari
    // realmente in coda — ma restava "Completata" per sempre in UI, nessun
    // punto la riportava a uno stato non terminale. checkAndComplete() la
    // riporterà a COMPLETED da solo quando l'ultimo di questi retry sarà
    // stato processato (stesso meccanismo già usato al lancio), quindi
    // basta sbloccarla qui senza duplicare quella logica.
    if (campaign.status === CampaignStatus.COMPLETED || campaign.status === CampaignStatus.FAILED) {
      await this.campaignRepo.update({ id: campaignId }, { status: CampaignStatus.QUEUED, completedAt: null });
    }

    const needsProtocolla = campaign.channelConfig?.['protocolla'] === true;
    if (effectiveChannel !== 'SEND' && !needsProtocolla) {
      await this.notificationQueues.addBulk(effectiveChannel as Exclude<NotificationChannel, 'SEND'>, [
        { name: NOTIFICATION_JOB_SEND, data: { campaignId, recipientId, attemptId, channel: effectiveChannel }, opts: { jobId: attemptId } },
      ]);
    } else if (effectiveChannel !== 'SEND' && needsProtocolla && inheritedProtocol.protocolledAt) {
      await this.notificationQueues.addBulk(effectiveChannel as Exclude<NotificationChannel, 'SEND'>, [
        { name: NOTIFICATION_JOB_SEND, data: { campaignId, recipientId, attemptId, channel: effectiveChannel }, opts: { jobId: attemptId } },
      ]);
    } else if (!inheritedProtocol.protocolledAt) {
      // Non eredita un protocollo già fatto: va (ri)protocollato dal motore dedicato.
      await this.notificationQueues.addBulk('PROTOCOLLAZIONE', [
        { name: NOTIFICATION_JOB_SEND, data: { campaignId, recipientId, attemptId, channel: effectiveChannel }, opts: { jobId: attemptId } },
      ]);
    }

    return { requeued: true, attemptId };
  }

  /**
   * Corregge l'indirizzo fisico di un singolo destinatario FAILED (es.
   * GlobalCom "Impossibile validare l'indirizzo", CAP/via non riconosciuti)
   * e lo rimette subito in coda — un solo giro per non lasciare la
   * correzione "salvata ma non ritentata". Scrive le colonne mappate da
   * `channelConfig.physicalAddressConfig` (stesse lette da
   * `resolvePhysicalAddress`, sia POSTAL che SEND): se la campagna non ha
   * ancora un mapping indirizzo (caricamento originale senza colonne
   * indirizzo dedicate, es. solo CF+contatti), ne crea uno nuovo puntato su
   * chiavi extraData dedicate — self-bootstrap, nessuna colonna CSV da
   * modificare a mano.
   */
  async updateRecipientAddressAndRetry(
    campaignId: string,
    recipientId: string,
    dto: { address: string; municipality: string; zip?: string; province?: string; country?: string; fullName?: string },
  ): Promise<{ requeued: true; attemptId: string }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    if (campaign.channelType !== 'POSTAL' && campaign.channelType !== 'SEND') {
      throw new BadRequestException('Correzione indirizzo disponibile solo per campagne POSTAL o SEND');
    }

    const recipient = await this.recipientRepo.findOne({ where: { id: recipientId } });
    if (!recipient || recipient.campaignId !== campaignId) {
      throw new NotFoundException(`Recipient ${recipientId} non trovato in questa campagna`);
    }

    let cfg = campaign.channelConfig?.['physicalAddressConfig'] as
      | { enabled: boolean; addressColumn: string; municipalityColumn: string; zipColumn?: string; provinceColumn?: string; countryColumn?: string }
      | undefined;
    if (!cfg?.enabled) {
      cfg = {
        enabled: true,
        addressColumn: '_editAddress',
        municipalityColumn: '_editMunicipality',
        zipColumn: '_editZip',
        provinceColumn: '_editProvince',
        countryColumn: '_editCountry',
      };
    } else if (!cfg.countryColumn) {
      // Mapping esistente (bulk originale) senza colonna paese: nessun CSV
      // aveva un indirizzo estero al momento del caricamento — aggiungiamo
      // solo qui la colonna dedicata, senza toccare le altre già in uso.
      cfg = { ...cfg, countryColumn: '_editCountry' };
    }
    campaign.channelConfig = { ...campaign.channelConfig, physicalAddressConfig: cfg };
    await this.campaignRepo.save(campaign);

    const extraData = { ...recipient.extraData };
    extraData[cfg.addressColumn] = dto.address;
    extraData[cfg.municipalityColumn] = dto.municipality;
    if (cfg.zipColumn) extraData[cfg.zipColumn] = dto.zip ?? '';
    if (cfg.provinceColumn) extraData[cfg.provinceColumn] = dto.province ?? '';
    if (cfg.countryColumn) extraData[cfg.countryColumn] = dto.country ?? '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- _QueryDeepPartialEntity non gestisce bene un
    // index signature generico (Record<string, unknown>) su colonna jsonb, stesso limite noto di TypeORM 0.3.x
    // (vedi launchTestSend/channelConfig sopra).
    const updateFields: Record<string, unknown> = { extraData };
    if (dto.fullName?.trim()) updateFields.fullName = dto.fullName.trim();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vedi nota sopra su extraData/_QueryDeepPartialEntity
    await this.recipientRepo.update(recipientId, updateFields as any);

    // Un errore di consegna POSTAL post-accettazione (es. GlobalCom
    // "Impossibile validare l'indirizzo", CodiceErrore reale su un attempt
    // che resta comunque status=SUCCESS — vedi gotcha CLAUDE.md "CodiceErrore
    // non legato allo Stato") non fa mai transitare recipient.status a
    // FAILED: nessun demone lo fa oggi. retryRecipient() richiede FAILED, quindi
    // qui — SOLO in risposta a un'azione esplicita dell'operatore (salva
    // correzione indirizzo), mai in automatico — forziamo la transizione prima
    // del retry, aggiornando i contatori campagna coerentemente.
    if (recipient.status !== RecipientStatus.FAILED) {
      await this.recipientRepo.update(recipientId, { status: RecipientStatus.FAILED });
      if (recipient.status === RecipientStatus.SENT) {
        await this.campaignRepo.decrement({ id: campaignId }, 'sentCount', 1);
      }
      await this.campaignRepo.increment({ id: campaignId }, 'failedCount', 1);
    }

    return this.retryRecipient(campaignId, recipientId);
  }

  /**
   * Ricontrollo manuale stato GlobalCom per l'ultimo attempt POSTAL di un
   * destinatario — caso reale: raccomandata `Errore` corretta a mano sul
   * portale GlobalCom (mai tramite un nostro retry), quindi mai più
   * ripollata dal cron perché già a stato terminale con costo calcolato
   * (vedi PostalStatusSyncService.handleCron). Nessuna modifica a
   * recipient.status/attempt.status: solo postalStatus/costCents, stesso
   * identico effetto di un giro di poll automatico ma su richiesta esplicita.
   */
  async refreshPostalStatus(campaignId: string, recipientId: string): Promise<{ changed: boolean; postalStatus: string | null }> {
    const recipient = await this.recipientRepo.findOne({ where: { id: recipientId } });
    if (!recipient || recipient.campaignId !== campaignId) {
      throw new NotFoundException(`Recipient ${recipientId} non trovato in questa campagna`);
    }
    const lastAttempt = await this.attemptRepo.findOne({
      where: { recipientId, channelType: 'POSTAL' },
      order: { attemptNumber: 'DESC' },
    });
    if (!lastAttempt) throw new BadRequestException('Nessun tentativo POSTAL per questo destinatario');

    return this.postalStatusSync.refreshOne(lastAttempt.id);
  }

  /**
   * Aggancio manuale IDPRO GlobalCom su un attempt SPECIFICO (attemptNumber
   * esplicito, mai "l'ultimo" implicito) — un destinatario può avere più
   * tentativi POSTAL, e più di uno può essere senza IDPRO: l'operatore deve
   * poter scegliere a quale riga dello storico agganciarlo, non solo
   * all'ultimo. Caso reale: invio davvero arrivato a GlobalCom (l'operatore
   * lo trova cercando a mano sul portale), ma il nostro attempt è rimasto
   * senza postalTrackingId per un bug di mapping (`isGoodExistingSubmission`/
   * dedup, vedi postal.strategy.ts) o un fallimento di parsing risposta.
   * Non tocca status/postalStatus da solo: dopo aver scritto l'IDPRO,
   * richiama subito refreshOne() per validarlo contro GlobalCom (se l'IDPRO
   * è sbagliato/inesistente, dettagliDocumento fallisce e l'errore risale
   * al chiamante — niente salvato a metà).
   */
  async attachPostalTrackingId(campaignId: string, recipientId: string, attemptNumber: number, idPro: string): Promise<{ changed: boolean; postalStatus: string | null }> {
    const trimmed = idPro.trim();
    if (!trimmed) throw new BadRequestException('IDPRO obbligatorio');

    const recipient = await this.recipientRepo.findOne({ where: { id: recipientId } });
    if (!recipient || recipient.campaignId !== campaignId) {
      throw new NotFoundException(`Recipient ${recipientId} non trovato in questa campagna`);
    }
    const attempt = await this.attemptRepo.findOne({
      where: { recipientId, channelType: 'POSTAL', attemptNumber },
    });
    if (!attempt) throw new NotFoundException(`Tentativo #${attemptNumber} POSTAL non trovato per questo destinatario`);
    if (attempt.postalTrackingId) {
      throw new BadRequestException(`Questo tentativo ha già un IDPRO salvato (${attempt.postalTrackingId}) — usa "Ricontrolla stato" per aggiornarlo, non un aggancio manuale`);
    }

    await this.attemptRepo.update(attempt.id, { postalTrackingId: trimmed });
    const result = await this.postalStatusSync.refreshOne(attempt.id);

    // L'IDPRO è stato validato da GlobalCom (refreshOne non ha lanciato) — se
    // l'attempt era FAILED lato nostro (es. eccezione dopo una chiamata SOAP
    // che in realtà era passata), non è più un fallimento: era solo il nostro
    // stato locale a non saperlo. Promuove a SUCCESS e allinea recipient/
    // contatori campagna, stesso pattern (invertito) di updateRecipientAddressAndRetry.
    // Senza questo, il destinatario resta FAILED in ogni report/breakdown pur
    // avendo un invio reale accettato, e retryRecipient() (gate su FAILED)
    // permetterebbe un secondo invio reale — rischio doppia spedizione.
    if (attempt.status === AttemptStatus.FAILED) {
      await this.attemptRepo.update(attempt.id, { status: AttemptStatus.SUCCESS });
      if (recipient.status === RecipientStatus.FAILED) {
        await this.recipientRepo.update(recipientId, { status: RecipientStatus.SENT });
        await this.campaignRepo.decrement({ id: campaignId }, 'failedCount', 1);
        await this.campaignRepo.increment({ id: campaignId }, 'sentCount', 1);
      }
    }

    return result;
  }

  /**
   * Reset di massa per l'intera campagna — vedi PostalStatusSyncService.resetErrorsForRecheck
   * per il razionale (raccomandate corrette a mano su GlobalCom, il cron non
   * le ripolla più da sola perché già a stato terminale).
   */
  async resetPostalErrorsForRecheck(campaignId: string): Promise<{ resetCount: number }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    if (campaign.channelType !== 'POSTAL') {
      throw new BadRequestException('Ricontrollo stato disponibile solo per campagne POSTAL');
    }
    return this.postalStatusSync.resetErrorsForRecheck(campaignId);
  }

  async getRecipientStats(
    campaignId: string,
    page: number,
    pageSize: number,
    search?: string,
    status?: string,
    deliveryStatus?: string,
    tags?: string[],
    hasDownload?: string,
  ): Promise<RecipientStatsPageDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const qb = this.recipientRepo
      .createQueryBuilder('r')
      .select([
        'r.id', 'r.fullName', 'r.codiceFiscale', 'r.email', 'r.pec', 'r.status',
        'r.downloadCount', 'r.firstDownloadedAt', 'r.lastDownloadedAt', 'r.attachmentDeletedAt',
        // inadCheck.diverted serve al frontend (widget multicanale, bottone
        // "Rimanda a questi N" su "Dirottato su PEC (INAD)") per filtrare
        // client-side i destinatari dirottati della pagina corrente — senza
        // questo campo il filtro `r.inadCheck?.diverted` era sempre vuoto
        // (bug reale trovato in verifica manuale: il bottone diceva sempre
        // "Nessun destinatario trovato" anche su una pagina con dirottati).
        'r.inadCheck',
      ])
      .where('r.campaignId = :campaignId', { campaignId });

    if (search && search.trim()) {
      qb.andWhere('(r.fullName ILIKE :search OR r.codiceFiscale ILIKE :search)', { search: `%${search.trim()}%` });
    }
    if (status) {
      qb.andWhere('r.status = :status', { status });
    }
    if (deliveryStatus === PENDING_DELIVERY_STATUS_SENTINEL) {
      // "In corso" (nessun send_status/postal_status ancora, es. attempt
      // riuscito ma non ancora sincronizzato — stesso caso null gestito da
      // ChannelStatusBar/pendingLabel in frontend) — attempt deve esistere
      // ed essere SUCCESS, altrimenti un FAILED pre-provider (mai un
      // send_status/postal_status per definizione) finirebbe qui invece che
      // sotto lo stato business FAILED sentinella già gestito altrove.
      // channel_type = campaign.channelType obbligatorio: un dirottato INAD
      // (attempt reale PEC, non POSTAL) ha send_status/postal_status NULL
      // anche lui (colonne mai popolate per PEC) — senza questo filtro
      // finiva anche lui in "In corso", pur avendo un canale che non avrà
      // mai un postalStatus (bug reale, visto in UI: dirottati con "—"
      // mescolati ai veri pending POSTAL sotto lo stesso filtro).
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM (
            SELECT DISTINCT ON (recipient_id) recipient_id, send_status, postal_status, status, channel_type
            FROM notification_attempts
            ORDER BY recipient_id, attempt_number DESC
          ) la
          WHERE la.recipient_id = r.id AND la.channel_type = :campaignChannelType AND la.status = 'success' AND la.send_status IS NULL AND la.postal_status IS NULL
        )`,
        { campaignChannelType: campaign.channelType },
      );
    } else if (deliveryStatus) {
      // "Stato Consegna" (SEND/POSTAL) vive sull'ultimo attempt del destinatario,
      // non su recipient.status — stesso identico sotto-query DISTINCT ON già
      // usato in getFailures() per "ultimo attempt per destinatario". Filtro su
      // send_status OR postal_status (mai entrambi valorizzati sullo stesso
      // attempt): stesso principio già applicato in getRecipientStats sopra,
      // nessun filtro su channelType — un destinatario dirottato da INAD ha
      // channelType diverso da quello di campagna sul suo attempt reale.
      qb.andWhere(
        `EXISTS (
          SELECT 1 FROM (
            SELECT DISTINCT ON (recipient_id) recipient_id, send_status, postal_status
            FROM notification_attempts
            ORDER BY recipient_id, attempt_number DESC
          ) la
          WHERE la.recipient_id = r.id AND (la.send_status = :deliveryStatus OR la.postal_status = :deliveryStatus)
        )`,
        { deliveryStatus },
      );
    }

    // Filtro "tipo di invio" multiselect — tag combinabili in AND (selezionare
    // "Dirottato INAD" + "App IO" mostra SOLO i destinatari che soddisfano
    // ENTRAMBI, non l'unione): ogni tag presente aggiunge un proprio andWhere.
    if (tags?.includes('diverted')) {
      qb.andWhere(`(r.inad_check->>'diverted')::boolean = true`);
    }
    if (tags?.includes('primary')) {
      qb.andWhere(`COALESCE((r.inad_check->>'diverted')::boolean, false) = false`);
    }
    if (tags?.includes('appio')) {
      // Co-consegna App IO tentata su un attempt qualsiasi del destinatario
      // (stesso criterio `a.appIo.attempted` già usato nel dettaglio
      // notifica) — appIo vive solo dentro response_payload jsonb, nessuna
      // colonna dedicata.
      qb.andWhere(
        `EXISTS (SELECT 1 FROM notification_attempts na WHERE na.recipient_id = r.id AND na.response_payload -> 'appIo' IS NOT NULL)`,
      );
    }
    if (hasDownload === 'yes') {
      qb.andWhere('r.download_count > 0');
    } else if (hasDownload === 'no') {
      qb.andWhere('r.download_count = 0');
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
      // Niente filtro su channelType: un destinatario dirottato da INAD ha
      // channelType diverso da campaign.channelType sul suo attempt reale
      // (es. POSTAL->PEC) — filtrare sul canale di campagna escludeva questi
      // attempt, mostrando "—" su protocollo/iun/stato anche quando il dato
      // esisteva davvero in DB (stesso bug già corretto altrove per
      // getSendStageCounts, mai applicato qui).
      const recipientIds = items.map((r) => r.id);
      const attempts = await this.attemptRepo.find({
        where: { recipientId: In(recipientIds) },
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

  /**
   * Valori distinti REALMENTE presenti tra i destinatari di questa campagna
   * (non l'intero enum) — popola le select filtro "Stato Notifica"/"Stato
   * Consegna" senza mostrare opzioni che non produrrebbero mai risultati.
   */
  async getRecipientFilterOptions(campaignId: string): Promise<{ statuses: string[]; deliveryStatuses: string[] }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const statusRows = await this.recipientRepo
      .createQueryBuilder('r')
      .select('DISTINCT r.status', 'status')
      .where('r.campaignId = :campaignId', { campaignId })
      .getRawMany<{ status: string }>();

    const deliveryRows = await this.recipientRepo
      .createQueryBuilder('r')
      .select(
        `DISTINCT COALESCE(la.send_status, la.postal_status)`,
        'deliveryStatus',
      )
      .leftJoin(
        `(SELECT DISTINCT ON (recipient_id) recipient_id, send_status, postal_status
          FROM notification_attempts ORDER BY recipient_id, attempt_number DESC)`,
        'la',
        'la.recipient_id = r.id',
      )
      .where('r.campaignId = :campaignId', { campaignId })
      .andWhere('COALESCE(la.send_status, la.postal_status) IS NOT NULL')
      .getRawMany<{ deliveryStatus: string }>();

    const pendingCount = await this.recipientRepo
      .createQueryBuilder('r')
      .leftJoin(
        `(SELECT DISTINCT ON (recipient_id) recipient_id, send_status, postal_status, status, channel_type
          FROM notification_attempts ORDER BY recipient_id, attempt_number DESC)`,
        'la',
        'la.recipient_id = r.id',
      )
      .where('r.campaignId = :campaignId', { campaignId })
      .andWhere(`la.channel_type = :campaignChannelType AND la.status = 'success' AND la.send_status IS NULL AND la.postal_status IS NULL`, { campaignChannelType: campaign.channelType })
      .getCount();

    return {
      statuses: statusRows.map((r) => r.status),
      deliveryStatuses: [
        ...deliveryRows.map((r) => r.deliveryStatus),
        ...(pendingCount > 0 ? [PENDING_DELIVERY_STATUS_SENTINEL] : []),
      ],
    };
  }

  async getDownloadReportRows(campaignId: string): Promise<DownloadReportDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const rows = await this.recipientRepo.find({
      where: { campaignId },
      select: ['codiceFiscale', 'fullName', 'email', 'pec', 'status', 'downloadCount', 'lastDownloadedAt', 'extraData'],
      order: { createdAt: 'ASC' },
    });

    const mapped = rows.map((r) => ({
      codiceFiscale: r.codiceFiscale,
      fullName: r.fullName,
      email: r.email,
      pec: r.pec,
      status: r.status,
      downloadCount: r.downloadCount,
      lastDownloadedAt: r.lastDownloadedAt ? r.lastDownloadedAt.toISOString() : null,
      externalId: resolveExternalId(campaign, r),
    }));

    return { hasExternalId: mapped.some((r) => r.externalId !== null), rows: mapped };
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
      select: ['id', 'codiceFiscale', 'fullName', 'extraData'],
      order: { createdAt: 'ASC' },
    });
    if (recipients.length === 0) return { hasAppIoCoDelivery: false, hasExternalId: false, rows: [] };

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
        externalId: resolveExternalId(campaign, r),
      };
    });

    return { hasAppIoCoDelivery, hasExternalId: rows.some((r) => r.externalId !== null), rows };
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

  async getCampaignCost(campaignId: string): Promise<CampaignCostDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipientIds = (await this.recipientRepo.find({ where: { campaignId }, select: ['id'] })).map((r) => r.id);
    if (recipientIds.length === 0) return { campaignId, totalCostCents: 0, byChannel: [] };

    const attempts = await this.attemptRepo.find({
      where: { recipientId: In(recipientIds), channelType: In(['SEND', 'POSTAL']) },
      select: ['recipientId', 'channelType', 'costCents', 'status'],
    });

    const byChannelMap = new Map<string, { totalCostCents: number; uncalculatedCount: number }>();
    for (const a of attempts) {
      const entry = byChannelMap.get(a.channelType) ?? { totalCostCents: 0, uncalculatedCount: 0 };
      // costCents === 0 trattato come "non ancora calcolato" alla pari di
      // NULL (stesso placeholder GlobalCom durante la lavorazione già noto
      // da postal-status-sync.service.ts/getCampaignCostSavings) — bug
      // reale segnalato: finiva silenziosamente nel totale come "già
      // costato a 0€" invece che nel conteggio "non calcolati", facendo
      // sembrare il costo totale fermo/basso mentre centinaia di record
      // aspettavano ancora il costo reale da GlobalCom.
      const notYetCosted = a.costCents === null || a.costCents === 0;
      if (notYetCosted && a.status !== AttemptStatus.FAILED) entry.uncalculatedCount += 1;
      else if (!notYetCosted && a.costCents !== null) entry.totalCostCents += a.costCents;
      byChannelMap.set(a.channelType, entry);
    }

    const byChannel = Array.from(byChannelMap.entries()).map(([channel, v]) => ({
      channel: channel as 'SEND' | 'POSTAL',
      totalCostCents: v.totalCostCents,
      uncalculatedCount: v.uncalculatedCount,
    }));

    return {
      campaignId,
      totalCostCents: byChannel.reduce((sum, c) => sum + c.totalCostCents, 0),
      byChannel,
    };
  }

  async getCampaignCostSavings(campaignId: string): Promise<CampaignCostSavingsDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    if (campaign.channelType === 'POSTAL') {
      // Un destinatario POSTAL dirottato (INAD su PEC, oppure App IO
      // esclusiva riuscita — skipPrimary, mai spedita la lettera) ha
      // risparmiato il costo di una spedizione reale. Prima si rispondeva
      // sempre "non stimabile" (nessun costo nozionale fisso per POSTAL, a
      // differenza di SEND che ha `send.digitalBaseFeeCents`): stimiamo ora
      // il risparmio come costo medio delle spedizioni POSTAL REALMENTE
      // inviate in questa campagna (uniche per destinatario — l'ultimo
      // attempt costato, per non sommare più volte un retry dello stesso
      // invio) moltiplicato per il numero di dirottati, quando esiste
      // almeno un invio POSTAL costato da cui ricavare una media.
      const recipients = await this.recipientRepo.find({ where: { campaignId }, select: ['id', 'inadCheck'] });
      const recipientIds = recipients.map((r) => r.id);
      const divertedIds = new Set<string>(recipients.filter((r) => r.inadCheck?.diverted).map((r) => r.id));

      if (resolveSecondaryAppIoConfig(campaign.channelConfig)) {
        const payloadByRecipient = await this.buildAggregatedAppIoPayloads(recipientIds);
        for (const [recipientId, payload] of payloadByRecipient) {
          if (payload['deliveredVia'] === 'APP_IO') divertedIds.add(recipientId);
        }
      }
      const divertedCount = divertedIds.size;
      if (divertedCount === 0) return { campaignId, totalSavingCents: 0, postalNotEstimableCount: 0 };

      const postalAttempts = await this.attemptRepo.find({
        where: { recipientId: In(recipientIds), channelType: 'POSTAL' },
        select: ['recipientId', 'attemptNumber', 'costCents'],
      });
      // Un solo costo per destinatario (l'attempt POSTAL costato più recente):
      // un retry rispedisce la STESSA lettera, sommare i costi di più
      // attempt dello stesso destinatario gonfierebbe la media.
      // cost_cents = 0 escluso alla pari di NULL (stesso principio di
      // postal-status-sync.service.ts): è un placeholder GlobalCom durante
      // la lavorazione, mai un costo reale — includerlo nella media abbassa
      // artificialmente la stima (bug reale segnalato: media tirata giù da
      // centinaia di record ancora "non calcolati", risparmio sottostimato).
      const lastCostedAttemptNumber = new Map<string, number>();
      const costByRecipient = new Map<string, number>();
      for (const a of postalAttempts) {
        if (a.costCents === null || a.costCents === 0) continue;
        const prevAttemptNumber = lastCostedAttemptNumber.get(a.recipientId) ?? -1;
        if (a.attemptNumber > prevAttemptNumber) {
          lastCostedAttemptNumber.set(a.recipientId, a.attemptNumber);
          costByRecipient.set(a.recipientId, a.costCents);
        }
      }
      const costedValues = [...costByRecipient.values()];
      if (costedValues.length === 0) {
        // Nessun invio POSTAL di questa campagna ha ancora un costo
        // calcolato (es. GlobalCom non ha ancora restituito il costo reale):
        // resta non stimabile, nessuna media disponibile da cui partire.
        return { campaignId, totalSavingCents: 0, postalNotEstimableCount: divertedCount };
      }
      const avgCostCents = costedValues.reduce((sum, c) => sum + c, 0) / costedValues.length;
      const totalSavingCents = Math.round(avgCostCents * divertedCount);
      return { campaignId, totalSavingCents, postalNotEstimableCount: 0 };
    }

    if (campaign.channelType !== 'SEND') {
      return { campaignId, totalSavingCents: 0, postalNotEstimableCount: 0 };
    }

    const recipients = await this.recipientRepo.find({ where: { campaignId }, select: ['id'] });
    const recipientIds = recipients.map((r) => r.id);
    if (recipientIds.length === 0) return { campaignId, totalSavingCents: 0, postalNotEstimableCount: 0 };

    const attempts = await this.attemptRepo.find({
      where: { recipientId: In(recipientIds), channelType: 'SEND' },
      select: ['recipientId', 'costCents'],
    });
    const costByRecipient = new Map<string, number>();
    for (const a of attempts) {
      costByRecipient.set(a.recipientId, (costByRecipient.get(a.recipientId) ?? 0) + (a.costCents ?? 0));
    }

    const nominalBaseFeeCents = await this.settings.get<number>('send.digitalBaseFeeCents');
    let totalSavingCents = 0;
    for (const id of recipientIds) {
      const actual = costByRecipient.get(id) ?? 0;
      const saving = nominalBaseFeeCents - actual;
      if (saving > 0) totalSavingCents += saving;
    }

    return { campaignId, totalSavingCents, postalNotEstimableCount: 0 };
  }

  /**
   * Somma degli importi PagoPA (channelConfig.paymentConfig, la stessa
   * mappatura colonna già usata da resolvePaymentData per SEND — vedi
   * payment-config.util.ts) su tutti i destinatari della campagna. Un solo
   * valore per destinatario, qualunque cosa rappresenti la colonna mappata
   * (rata unica o totale rate: dipende da cosa ha scelto l'operatore in
   * Impostazioni, non deciso qui). Nessuna sezione da mostrare se la
   * campagna non ha paymentConfig abilitato.
   */
  async getCampaignPaymentTotal(campaignId: string): Promise<CampaignPaymentTotalDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const paymentConfig = campaign.channelConfig?.['paymentConfig'] as Record<string, any> | undefined;
    if (!paymentConfig?.enabled) {
      return { campaignId, enabled: false, totalAmountCents: 0, recipientsWithPaymentCount: 0 };
    }

    const recipients = await this.recipientRepo.find({
      where: { campaignId },
      select: ['id', 'codiceFiscale', 'fullName', 'email', 'pec', 'extraData'],
    });

    let totalAmountCents = 0;
    let recipientsWithPaymentCount = 0;
    for (const recipient of recipients) {
      const resolved = resolvePaymentData(recipient, paymentConfig);
      if (resolved?.amountCents) {
        totalAmountCents += resolved.amountCents;
        recipientsWithPaymentCount += 1;
      }
    }

    return { campaignId, enabled: true, totalAmountCents, recipientsWithPaymentCount };
  }

  async getPostalReportRows(campaignId: string): Promise<PostalReportDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipients = await this.recipientRepo.find({
      where: { campaignId },
      select: ['id', 'codiceFiscale', 'fullName', 'extraData'],
      order: { createdAt: 'ASC' },
    });
    if (recipients.length === 0) return { hasAppIoCoDelivery: false, hasExternalId: false, rows: [] };

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
        externalId: resolveExternalId(campaign, r),
      };
    });

    return { hasAppIoCoDelivery, hasExternalId: rows.some((r) => r.externalId !== null), rows };
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
   * Risolve il path assoluto di un file già caricato nella cartella uploads
   * di una campagna bozza (usato per l'anteprima allegato dal wizard, prima
   * che esistano recipient/attempt reali). `filename` arriva da query string
   * lato utente: mai costruire il path direttamente da input — si valida per
   * uguaglianza di stringa contro l'elenco reale (whitelist), che previene
   * path traversal senza bisogno di sanitizzare `filename`.
   */
  async resolveAttachmentPreviewFilePath(
    campaignId: string,
    filename: string,
  ): Promise<{ path: string; contentType: string }> {
    const exists = await this.campaignRepo.existsBy({ id: campaignId });
    if (!exists) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const dir = getUploadsDir(campaignId);
    const present = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    if (!present.includes(filename)) {
      throw new NotFoundException('Allegato non trovato — verifica il Passo 5');
    }

    const contentType = filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
    return { path: join(dir, filename), contentType };
  }

  /**
   * Post-processing degli allegati caricati:
   * 1. estrae i PDF dagli eventuali .zip (appiattendo i path) e rimuove gli zip;
   * 2. elimina i PDF non referenziati da alcun destinatario (extraData/allegatoKey).
   * Safety: se NESSUN destinatario referenzia un allegato, non scarta nulla
   * (evita di svuotare la cartella in flussi senza mappatura allegato).
   */
  async getReferencedAttachments(campaign: Campaign): Promise<Set<string>> {
    const recipients = await this.recipientRepo.find({
      where: { campaignId: campaign.id },
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
    return referenced;
  }

  async getAttachmentsProgress(
    campaignId: string,
  ): Promise<{ attachmentsExpected: number; attachmentsPresent: number; filenames: string[] }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const referenced = await this.getReferencedAttachments(campaign);
    const dir = getUploadsDir(campaignId);
    const currentFiles = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f !== 'draft_recipients.csv')
      : [];
    const attachmentsPresent = currentFiles.filter((f) => referenced.has(f)).length;

    return {
      attachmentsExpected: referenced.size,
      attachmentsPresent,
      filenames: currentFiles,
    };
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
  ): Promise<{ uploaded: number; discarded: number; attachmentsExpected: number; attachmentsPresent: number; filenames: string[] }> {
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
    const referenced = await this.getReferencedAttachments(campaign);

    // 3. Ridenominazione per case-insensitivity e scarto dei non referenziati
    const referencedLowerMap = new Map<string, string>();
    for (const ref of referenced) {
      referencedLowerMap.set(ref.toLowerCase(), ref);
    }

    let discarded = 0;
    const present = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    for (const f of present) {
      if (f === 'draft_recipients.csv') continue;
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

    const finalFiles = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f !== 'draft_recipients.csv')
      : [];
    const uploaded = finalFiles.length;
    const attachmentsPresent = finalFiles.filter((f) => referenced.has(f)).length;

    return {
      uploaded,
      discarded,
      attachmentsExpected: referenced.size,
      attachmentsPresent,
      filenames: finalFiles,
    };
  }

  async remove(campaignId: string, requester: CampaignRequester): Promise<{ deleted: true }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    this.assertOwnership(campaign, requester);
    if (isCampaignLegalValue(campaign) && campaign.status !== CampaignStatus.DRAFT) {
      throw new BadRequestException('Campagna a valore legale: eliminazione non consentita per campagne avviate');
    }

    const linkedTestCampaign = await this.campaignRepo.findOneBy({ parentCampaignId: campaignId, isTest: true });
    if (linkedTestCampaign) {
      const testRecipients = await this.recipientRepo.find({ where: { campaignId: linkedTestCampaign.id }, select: ['id'] });
      const testRecipientIds = testRecipients.map((r) => r.id);
      if (testRecipientIds.length > 0) {
        await this.attemptRepo.delete({ recipientId: In(testRecipientIds) });
        await this.recipientRepo.delete({ id: In(testRecipientIds) });
      }
      await this.campaignRepo.delete(linkedTestCampaign.id);
      await fs.promises.rm(getUploadsDir(linkedTestCampaign.id), { recursive: true, force: true });
    }

    await fs.promises.rm(getUploadsDir(campaignId), { recursive: true, force: true });
    await this.campaignRepo.delete(campaignId);

    return { deleted: true };
  }
}

