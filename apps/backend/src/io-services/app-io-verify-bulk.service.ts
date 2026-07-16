import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { AppIoVerificationJob, AppIoVerificationJobStatus } from '../entities/app-io-verification-job.entity';
import { IoServiceConfig } from '../entities/io-service-config.entity';
import { parseCsvContent } from './csv.util';
import { APP_IO_VERIFY_BULK_QUEUE, AppIoVerifyBulkJobData } from './app-io-verify-bulk-job.types';

export interface CreateBulkVerifyParams {
  csvContent: string;
  hasHeaders: boolean;
  cfColumn: string;
  ioServiceId: string;
}

export interface CreateBulkVerifyResult {
  jobId?: string;
  blocked?: boolean;
  message?: string;
}

export interface BulkVerifyStatus {
  status: AppIoVerificationJobStatus;
  totalRows: number;
  processedRows: number;
  presentCount: number;
  absentCount: number;
  errorMessage: string | null;
}

@Injectable()
export class AppIoVerifyBulkService {
  constructor(
    @InjectRepository(AppIoVerificationJob)
    private readonly jobRepo: Repository<AppIoVerificationJob>,
    @InjectRepository(IoServiceConfig)
    private readonly ioServiceRepo: Repository<IoServiceConfig>,
    @InjectQueue(APP_IO_VERIFY_BULK_QUEUE)
    private readonly queue: Queue<AppIoVerifyBulkJobData>,
  ) {}

  async createJob(params: CreateBulkVerifyParams): Promise<CreateBulkVerifyResult> {
    const service = await this.ioServiceRepo.findOneBy({ id: params.ioServiceId });
    if (!service) {
      return { blocked: true, message: 'Servizio App IO selezionato non trovato' };
    }

    const parsed = parseCsvContent(params.csvContent, params.hasHeaders);
    if (parsed.rows.length === 0) {
      return { blocked: true, message: 'Il CSV caricato non contiene righe di dati' };
    }
    if (!parsed.headers.includes(params.cfColumn)) {
      return { blocked: true, message: `Colonna "${params.cfColumn}" non trovata tra le intestazioni del CSV` };
    }

    const job = this.jobRepo.create({
      status: AppIoVerificationJobStatus.QUEUED,
      totalRows: parsed.rows.length,
      processedRows: 0,
      presentCount: 0,
      absentCount: 0,
      sourceCsv: params.csvContent,
      csvHeaders: parsed.headers,
      cfColumn: params.cfColumn,
      hasHeaders: params.hasHeaders,
      ioServiceId: params.ioServiceId,
      resultPresentCsv: null,
      resultAbsentCsv: null,
      errorMessage: null,
      completedAt: null,
    });
    const saved = await this.jobRepo.save(job);

    await this.queue.add('verify', { jobId: saved.id }, { jobId: saved.id });

    return { jobId: saved.id };
  }

  async getStatus(jobId: string): Promise<BulkVerifyStatus> {
    const job = await this.jobRepo.findOneBy({ id: jobId });
    if (!job) throw new NotFoundException(`Job di verifica ${jobId} non trovato`);
    return {
      status: job.status,
      totalRows: job.totalRows,
      processedRows: job.processedRows,
      presentCount: job.presentCount,
      absentCount: job.absentCount,
      errorMessage: job.errorMessage,
    };
  }

  async getResultCsv(jobId: string, variant: 'present' | 'absent'): Promise<string> {
    const job = await this.jobRepo.findOneBy({ id: jobId });
    if (!job) throw new NotFoundException(`Job di verifica ${jobId} non trovato`);
    if (job.status !== AppIoVerificationJobStatus.DONE) {
      throw new BadRequestException('Il job di verifica non è ancora completato');
    }
    const content = variant === 'present' ? job.resultPresentCsv : job.resultAbsentCsv;
    if (!content) throw new NotFoundException('Risultato non disponibile');
    return content;
  }
}
