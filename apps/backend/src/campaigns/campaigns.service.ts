import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { parse } from 'csv-parse';
import * as fs from 'fs';
import { basename, join } from 'path';
import AdmZip from 'adm-zip';
import { getUploadsDir } from '../attachments/attachment-paths';
import { resolveCustomAttachmentFilename } from '../attachments/attachment.service';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { NOTIFICATION_JOB_SEND } from '../queue/notification-job.types';
import { NotificationQueuesService } from '../queue/notification-queues.service';
import type { CreateCampaignDto } from './dto/create-campaign.dto';
import type { UpdateCampaignDto } from './dto/update-campaign.dto';
import type { CampaignStatsDto, RecipientStatsPageDto } from './dto/campaign-stats.dto';


@Injectable()
export class CampaignsService {
  constructor(
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    private readonly notificationQueues: NotificationQueuesService,
  ) {}

  findAll(): Promise<Campaign[]> {
    return this.campaignRepo.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: string): Promise<Campaign> {
    const campaign = await this.campaignRepo.findOne({
      where: { id },
      relations: ['recipients'],
    });
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
  ): Promise<{ imported: number; campaignId: string }> {
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
    } finally {
      await unlink(filePath).catch(() => undefined);
    }

    return { imported, campaignId };
  }

  async launch(campaignId: string): Promise<{ launched: number; campaignId: string }> {
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

    const recipients = await this.recipientRepo.find({
      where: { campaignId, status: RecipientStatus.PENDING },
      select: ['id'],
    });

    if (recipients.length === 0) {
      throw new BadRequestException('No pending recipients — upload a CSV first');
    }

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
            channelType: campaign.channelType,
            status: AttemptStatus.QUEUED,
          })),
        )
        .returning('id')
        .execute();
      attemptIds.push(...(result.raw as Array<{ id: string }>).map((row) => row.id));
    }

    // Accoda job BullMQ in bulk (chunk di 1000 per evitare payload Redis troppo grandi)
    const JOB_CHUNK = 1000;
    for (let i = 0; i < recipients.length; i += JOB_CHUNK) {
      const chunk = recipients.slice(i, i + JOB_CHUNK);
      await this.notificationQueues.addBulk(
        campaign.channelType,
        chunk.map((r, idx) => ({
          name: NOTIFICATION_JOB_SEND,
          data: {
            campaignId,
            recipientId: r.id,
            attemptId: attemptIds[i + idx],
            channel: campaign.channelType,
          },
        })),
      );
    }

    await this.recipientRepo.update(
      { campaignId, status: RecipientStatus.PENDING },
      { status: RecipientStatus.QUEUED },
    );

    return { launched: recipients.length, campaignId };
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

  async getFailures(campaignId: string): Promise<Array<{
    recipientId: string;
    codiceFiscale: string;
    fullName: string | null;
    errorMessage: string | null;
    attemptNumber: number;
    lastAttemptAt: string;
  }>> {
    // Solo i destinatari il cui stato ATTUALE è FAILED (non righe di tentativi
    // storici: un destinatario ritentato con successo non deve più comparire qui).
    const failedRecipients = await this.recipientRepo.find({
      where: { campaignId, status: RecipientStatus.FAILED },
      order: { createdAt: 'DESC' },
    });

    return Promise.all(
      failedRecipients.map(async (r) => {
        const lastAttempt = await this.attemptRepo.findOne({
          where: { recipientId: r.id },
          order: { attemptNumber: 'DESC' },
        });
        return {
          recipientId: r.id,
          codiceFiscale: r.codiceFiscale,
          fullName: r.fullName,
          errorMessage: lastAttempt?.errorMessage ?? null,
          attemptNumber: lastAttempt?.attemptNumber ?? 0,
          lastAttemptAt: (lastAttempt?.createdAt ?? r.createdAt).toISOString(),
        };
      }),
    );
  }

  async retryRecipient(campaignId: string, recipientId: string): Promise<{ requeued: true; attemptId: string }> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

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

    const result = await this.attemptRepo
      .createQueryBuilder()
      .insert()
      .into(NotificationAttempt)
      .values({ recipientId, channelType: campaign.channelType, status: AttemptStatus.QUEUED, attemptNumber: nextAttemptNumber })
      .returning('id')
      .execute();
    const attemptId = (result.raw as Array<{ id: string }>)[0].id;

    await this.recipientRepo.update({ id: recipientId }, { status: RecipientStatus.QUEUED });
    await this.campaignRepo.decrement({ id: campaignId }, 'failedCount', 1);

    await this.notificationQueues.addBulk(campaign.channelType, [
      { name: NOTIFICATION_JOB_SEND, data: { campaignId, recipientId, attemptId, channel: campaign.channelType } },
    ]);

    return { requeued: true, attemptId };
  }

  async getRecipientStats(campaignId: string, page: number, pageSize: number): Promise<RecipientStatsPageDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const [items, total] = await this.recipientRepo.findAndCount({
      where: { campaignId },
      select: ['id', 'fullName', 'codiceFiscale', 'downloadCount', 'firstDownloadedAt', 'lastDownloadedAt', 'attachmentDeletedAt'],
      skip: (page - 1) * pageSize,
      take: pageSize,
      order: { createdAt: 'ASC' },
    });

    return { campaignId, page, pageSize, total, items };
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
      const zip = new AdmZip(file.path);
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue;
        const name = basename(entry.entryName); // neutralizza path traversal
        if (!name.toLowerCase().endsWith('.pdf')) continue;
        fs.writeFileSync(join(dir, name), entry.getData());
      }
      fs.unlinkSync(file.path);
    }

    // 2. Set dei filename referenziati dai destinatari
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);
    const recipients = await this.recipientRepo.find({
      where: { campaignId },
      select: ['extraData'],
    });
    const referenced = new Set<string>();
    for (const r of recipients) {
      const filename = resolveCustomAttachmentFilename({
        campaign,
        extraData: r.extraData,
      } as unknown as Recipient);
      if (filename) referenced.add(filename);
    }

    // 3. Scarto dei non referenziati
    let discarded = 0;
    const present = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    for (const f of present) {
      if (!referenced.has(f)) {
        fs.unlinkSync(join(dir, f));
        discarded++;
      }
    }

    const uploaded = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
    return { uploaded, discarded };
  }
}

