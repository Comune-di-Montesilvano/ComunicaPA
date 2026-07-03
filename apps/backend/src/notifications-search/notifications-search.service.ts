import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Recipient } from '../entities/recipient.entity';

export interface SearchFilters {
  codiceFiscale?: string;
  campaignId?: string;
  channelType?: string;
  status?: string;
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
}
