import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { CampaignsService } from '../campaigns/campaigns.service';
import { SendLegalFactsService, type SendLegalFactItem, type SendLegalFactDownloadResult } from '../channels/send/send-legal-facts.service';
import type { NotificationDetailDto } from './dto/notification-detail.dto';

export interface SearchFilters {
  codiceFiscale?: string;
  query?: string;
  campaignId?: string;
  channelType?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  page: number;
  pageSize: number;
}

export interface SearchRowDto {
  recipientId: string;
  campaignId: string;
  campaignName: string;
  codiceFiscale: string;
  fullName: string | null;
  channelType: string;
  status: string;
  createdAt: string;
}

@Injectable()
export class NotificationsSearchService {
  constructor(
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(DownloadEvent)
    private readonly downloadEventRepo: Repository<DownloadEvent>,
    private readonly campaignsService: CampaignsService,
    private readonly sendLegalFacts: SendLegalFactsService,
  ) {}

  async search(filters: SearchFilters): Promise<{ rows: SearchRowDto[]; total: number }> {
    const qb = this.recipientRepo
      .createQueryBuilder('recipient')
      .leftJoinAndSelect('recipient.campaign', 'campaign');

    const searchText = filters.query || filters.codiceFiscale;
    if (searchText) {
      const q = `%${searchText.trim()}%`;
      qb.andWhere(
        '(LOWER(recipient.codiceFiscale) LIKE LOWER(:q) OR LOWER(recipient.fullName) LIKE LOWER(:q) OR LOWER(recipient.email) LIKE LOWER(:q) OR LOWER(recipient.pec) LIKE LOWER(:q) OR EXISTS (SELECT 1 FROM notification_attempts a WHERE a.recipient_id = recipient.id AND LOWER(a.iun) LIKE LOWER(:q)))',
        { q },
      );
    }
    if (filters.campaignId) {
      qb.andWhere('recipient.campaignId = :campaignId', { campaignId: filters.campaignId });
    }
    if (filters.status) {
      qb.andWhere('recipient.status = :status', { status: filters.status });
    }
    if (filters.channelType) {
      qb.andWhere('campaign.channelType = :channelType', { channelType: filters.channelType });
    }
    if (filters.dateFrom) {
      qb.andWhere('recipient.createdAt >= :dateFrom', { dateFrom: filters.dateFrom });
    }
    if (filters.dateTo) {
      qb.andWhere('recipient.createdAt < (:dateTo::date + interval \'1 day\')', { dateTo: filters.dateTo });
    }

    qb.orderBy('recipient.createdAt', 'DESC')
      .skip((filters.page - 1) * filters.pageSize)
      .take(filters.pageSize);

    const [rows, total] = await qb.getManyAndCount();

    return {
      rows: rows.map((r) => ({
        recipientId: r.id,
        campaignId: r.campaignId,
        campaignName: r.campaign.name,
        codiceFiscale: r.codiceFiscale,
        fullName: r.fullName,
        channelType: r.campaign.channelType,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
    };
  }

  async getDetail(recipientId: string): Promise<NotificationDetailDto> {
    const recipient = await this.recipientRepo.findOne({
      where: { id: recipientId },
      relations: ['campaign'],
    });
    if (!recipient) throw new NotFoundException(`Recipient ${recipientId} not found`);

    const attempts = await this.attemptRepo.find({
      where: { recipientId },
      order: { attemptNumber: 'ASC' },
    });

    const downloads = await this.downloadEventRepo.find({
      where: { recipientId },
      order: { downloadedAt: 'ASC' },
    });

    const preview = await this.campaignsService.renderMessageForRecipient(recipientId);
    const appIoDelivered = attempts.some((a) => (a.responsePayload?.['appIo'] as { success?: boolean } | undefined)?.success);
    const appIoPreview = appIoDelivered ? await this.campaignsService.renderAppIoCoDeliveryPreview(recipientId) : null;

    return {
      recipient: {
        id: recipient.id,
        codiceFiscale: recipient.codiceFiscale,
        fullName: recipient.fullName,
        email: recipient.email,
        pec: recipient.pec,
        status: recipient.status,
      },
      campaign: {
        id: recipient.campaign.id,
        name: recipient.campaign.name,
        channelType: recipient.campaign.channelType,
      },
      attempts: attempts.map((a) => {
        const appIoPayload = a.responsePayload?.['appIo'] as { success?: boolean; error?: string } | undefined;
        return {
          attemptNumber: a.attemptNumber,
          status: a.status,
          channelType: a.channelType,
          errorMessage: a.errorMessage,
          sentAt: a.sentAt ? a.sentAt.toISOString() : null,
          createdAt: a.createdAt.toISOString(),
          appIo: appIoPayload
            ? { attempted: true as const, success: !!appIoPayload.success, error: appIoPayload.error ?? null }
            : { attempted: false as const },
          iun: a.iun,
          sendStatus: a.sendStatus,
          sendStatusUpdatedAt: a.sendStatusUpdatedAt ? a.sendStatusUpdatedAt.toISOString() : null,
          protocolNumber: a.protocolNumber,
          protocolYear: a.protocolYear,
          protocolledAt: a.protocolledAt ? a.protocolledAt.toISOString() : null,
          postalTrackingId: a.postalTrackingId,
          postalStatus: a.postalStatus,
          postalStatusUpdatedAt: a.postalStatusUpdatedAt ? a.postalStatusUpdatedAt.toISOString() : null,
        };
      }),
      downloads: downloads.map((d) => ({
        channel: d.channel,
        attachmentIndex: d.attachmentIndex,
        downloadedAt: d.downloadedAt.toISOString(),
      })),
      preview,
      appIoPreview,
    };
  }

  async getSendLegalFacts(recipientId: string): Promise<{ items: SendLegalFactItem[] }> {
    const attempt = await this.attemptRepo.findOne({
      where: { recipientId, channelType: 'SEND' },
      order: { createdAt: 'DESC' },
    });
    if (!attempt?.iun) return { items: [] };
    const items = await this.sendLegalFacts.listLegalFacts(attempt.iun);
    return { items };
  }

  async downloadSendLegalFact(recipientId: string, legalFactId: string): Promise<SendLegalFactDownloadResult> {
    const attempt = await this.attemptRepo.findOne({
      where: { recipientId, channelType: 'SEND' },
      order: { createdAt: 'DESC' },
    });
    if (!attempt?.iun) return { ready: false, error: 'Nessun IUN disponibile per questo destinatario' };
    return this.sendLegalFacts.downloadLegalFact(attempt.iun, legalFactId);
  }
}
