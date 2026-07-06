import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { CampaignsService } from '../campaigns/campaigns.service';
import type { NotificationDetailDto } from './dto/notification-detail.dto';

export interface SearchFilters {
  codiceFiscale?: string;
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
    private readonly campaignsService: CampaignsService,
  ) {}

  async search(filters: SearchFilters): Promise<{ rows: SearchRowDto[]; total: number }> {
    const qb = this.recipientRepo
      .createQueryBuilder('recipient')
      .leftJoinAndSelect('recipient.campaign', 'campaign');

    if (filters.codiceFiscale) {
      qb.andWhere('recipient.codiceFiscale = :cf', { cf: filters.codiceFiscale.toUpperCase().trim() });
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

    const preview = await this.campaignsService.renderMessageForRecipient(recipientId);

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
        };
      }),
      preview,
    };
  }
}
