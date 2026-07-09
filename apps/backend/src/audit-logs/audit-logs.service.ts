import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { AuditLog } from '../entities/audit-log.entity';

export interface AuditLogQueryDto {
  page?: number;
  pageSize?: number;
  search?: string;
}

@Injectable()
export class AuditLogsService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepo: Repository<AuditLog>,
  ) {}

  async log(data: {
    campaignId?: string | null;
    campaignName?: string | null;
    operator: string;
    action: string;
    details?: Record<string, any> | null;
  }): Promise<AuditLog> {
    const logEntry = this.auditLogRepo.create({
      campaignId: data.campaignId || null,
      campaignName: data.campaignName || null,
      operator: data.operator,
      action: data.action,
      details: data.details || null,
    });
    return this.auditLogRepo.save(logEntry);
  }

  async findAll(query: AuditLogQueryDto): Promise<{
    data: AuditLog[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = Math.max(Number(query.page || 1), 1);
    const pageSize = Math.max(Number(query.pageSize || 50), 1);
    const search = (query.search || '').trim();

    const skip = (page - 1) * pageSize;

    let where: any = {};
    if (search) {
      where = [
        { operator: Like(`%${search}%`) },
        { campaignName: Like(`%${search}%`) },
        { action: Like(`%${search}%`) },
      ];
    }

    const [data, total] = await this.auditLogRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip,
      take: pageSize,
    });

    return {
      data,
      total,
      page,
      pageSize,
    };
  }
}
