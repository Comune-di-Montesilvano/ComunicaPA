import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InadVerificationJob, InadVerificationJobStatus, InadVerificationBatch } from '../../entities/inad-verification-job.entity';
import { parseCsvContent } from '../../io-services/csv.util';
import { InadService } from './inad.service';

const BATCH_SIZE = 1000;

export interface CreateInadBulkVerifyParams {
  csvContent: string;
  hasHeaders: boolean;
  cfColumn: string;
}

export interface CreateInadBulkVerifyResult {
  jobId?: string;
  blocked?: boolean;
  message?: string;
}

export interface InadBulkVerifyStatus {
  status: InadVerificationJobStatus;
  totalRows: number;
  batchesTotal: number;
  batchesDone: number;
  foundCount: number;
  notFoundCount: number;
  errorMessage: string | null;
}

/**
 * Duplicato di AppIoVerifyBulkService ma su INAD (/listDigitalAddress) invece
 * di App IO — stesso schema upload CSV + poll + due CSV risultato, ma
 * l'elaborazione non gira per-riga in un processor BullMQ locale: INAD batcha
 * lato suo (fino a 1000 CF per chiamata, 5-10 minuti), quindi qui si accoda
 * solo la richiesta bulk e il progresso viene sincronizzato da
 * InadVerifyBulkSyncService (demone Cron, stesso pattern di InadCheckSyncService).
 */
@Injectable()
export class InadVerifyBulkService {
  constructor(
    @InjectRepository(InadVerificationJob)
    private readonly jobRepo: Repository<InadVerificationJob>,
    private readonly inadService: InadService,
  ) {}

  async createJob(params: CreateInadBulkVerifyParams): Promise<CreateInadBulkVerifyResult> {
    const parsed = parseCsvContent(params.csvContent, params.hasHeaders);
    if (parsed.rows.length === 0) {
      return { blocked: true, message: 'Il CSV caricato non contiene righe di dati' };
    }
    if (!parsed.headers.includes(params.cfColumn)) {
      return { blocked: true, message: `Colonna "${params.cfColumn}" non trovata tra le intestazioni del CSV` };
    }

    const validCfs = Array.from(
      new Set(
        parsed.rows
          .map((row) => (row[params.cfColumn] || '').trim().toUpperCase())
          .filter((cf) => cf.length === 16),
      ),
    );
    if (validCfs.length === 0) {
      return { blocked: true, message: 'Nessun codice fiscale valido (16 caratteri) trovato nella colonna selezionata' };
    }

    const job = this.jobRepo.create({
      status: InadVerificationJobStatus.QUEUED,
      totalRows: parsed.rows.length,
      batches: [],
      foundCount: 0,
      notFoundCount: 0,
      sourceCsv: params.csvContent,
      csvHeaders: parsed.headers,
      cfColumn: params.cfColumn,
      hasHeaders: params.hasHeaders,
      resultFoundCsv: null,
      resultNotFoundCsv: null,
      errorMessage: null,
      completedAt: null,
    });
    const saved = await this.jobRepo.save(job);

    try {
      const batches: InadVerificationBatch[] = [];
      for (let i = 0; i < validCfs.length; i += BATCH_SIZE) {
        const chunk = validCfs.slice(i, i + BATCH_SIZE);
        const { id } = await this.inadService.startBulkExtraction(chunk, `comunicapa-verifica-${saved.id}`);
        batches.push({ id, size: chunk.length, done: false });
      }
      await this.jobRepo.update(saved.id, { status: InadVerificationJobStatus.PROCESSING, batches });
    } catch (err: any) {
      await this.jobRepo.update(saved.id, {
        status: InadVerificationJobStatus.FAILED,
        errorMessage: err.message,
        completedAt: new Date(),
      });
    }

    return { jobId: saved.id };
  }

  async getStatus(jobId: string): Promise<InadBulkVerifyStatus> {
    const job = await this.jobRepo.findOneBy({ id: jobId });
    if (!job) throw new NotFoundException(`Job di verifica ${jobId} non trovato`);
    return {
      status: job.status,
      totalRows: job.totalRows,
      batchesTotal: job.batches.length,
      batchesDone: job.batches.filter((b) => b.done).length,
      foundCount: job.foundCount,
      notFoundCount: job.notFoundCount,
      errorMessage: job.errorMessage,
    };
  }

  async getResultCsv(jobId: string, variant: 'found' | 'notfound'): Promise<string> {
    const job = await this.jobRepo.findOneBy({ id: jobId });
    if (!job) throw new NotFoundException(`Job di verifica ${jobId} non trovato`);
    if (job.status !== InadVerificationJobStatus.DONE) {
      throw new BadRequestException('Il job di verifica non è ancora completato');
    }
    const content = variant === 'found' ? job.resultFoundCsv : job.resultNotFoundCsv;
    if (!content) throw new NotFoundException('Risultato non disponibile');
    return content;
  }
}
