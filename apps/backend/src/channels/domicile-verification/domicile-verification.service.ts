import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import {
  DomicileVerificationJob,
  DomicileVerificationJobStatus,
  DomicileInadBatch,
} from '../../entities/domicile-verification-job.entity.js';
import { IoServiceConfig } from '../../entities/io-service-config.entity.js';
import { parseCsvContent } from '../../io-services/csv.util.js';
import { APP_IO_VERIFY_BULK_QUEUE, AppIoVerifyBulkJobData } from '../../io-services/app-io-verify-bulk-job.types.js';
import { InadService } from '../inad/inad.service.js';
import { RegistroImpreseVerifyQueueService } from '../registro-imprese/registro-imprese-verify-queue.service.js';
import { isPartitaIva } from '../tax-id.util.js';

const BATCH_SIZE = 1000;
const CF_FISICO_LENGTH = 16;

export interface CreateDomicileVerificationJobParams {
  csvContent: string;
  hasHeaders: boolean;
  cfColumn: string;
  ioServiceId: string;
}

export interface CreateDomicileVerificationJobResult {
  jobId?: string;
  blocked?: boolean;
  message?: string;
}

export interface DomicileVerificationStatus {
  status: DomicileVerificationJobStatus;
  totalRows: number;
  cfFisicoTotal: number;
  pivaTotal: number;
  inadBatchesTotal: number;
  inadBatchesDone: number;
  inadFoundCount: number;
  appIoDone: boolean;
  appIoProcessedRows: number;
  appIoPresentCount: number;
  registroImpreseTotal: number;
  registroImpreseDone: number;
  registroImpreseFoundCount: number;
  errorMessage: string | null;
}

export interface DomicileVerificationJobSummary {
  id: string;
  status: DomicileVerificationJobStatus;
  createdAt: Date;
  totalRows: number;
  cfFisicoTotal: number;
  pivaTotal: number;
}

export type DomicileVerificationCsvVariant = 'assenti' | 'app-io' | 'inad' | 'registro-imprese' | 'aggregato';

const CSV_COLUMN_BY_VARIANT: Record<DomicileVerificationCsvVariant, keyof DomicileVerificationJob> = {
  'assenti': 'resultAssentiCsv',
  'app-io': 'resultAppIoCsv',
  'inad': 'resultInadCsv',
  'registro-imprese': 'resultRegistroImpreseCsv',
  'aggregato': 'resultAggregatoCsv',
};

@Injectable()
export class DomicileVerificationService {
  private readonly logger = new Logger(DomicileVerificationService.name);

  constructor(
    @InjectRepository(DomicileVerificationJob)
    private readonly jobRepo: Repository<DomicileVerificationJob>,
    @InjectRepository(IoServiceConfig)
    private readonly ioServiceRepo: Repository<IoServiceConfig>,
    private readonly inadService: InadService,
    private readonly registroImpreseQueue: RegistroImpreseVerifyQueueService,
    @InjectQueue(APP_IO_VERIFY_BULK_QUEUE)
    private readonly appIoQueue: Queue<AppIoVerifyBulkJobData>,
  ) {}

  async createJob(params: CreateDomicileVerificationJobParams): Promise<CreateDomicileVerificationJobResult> {
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

    const rawValues = parsed.rows.map((row) => (row[params.cfColumn] || '').trim().toUpperCase());
    const cfFisici = Array.from(new Set(rawValues.filter((v) => v.length === CF_FISICO_LENGTH)));
    const pive = Array.from(new Set(rawValues.filter((v) => isPartitaIva(v))));
    if (cfFisici.length === 0 && pive.length === 0) {
      return { blocked: true, message: 'Nessun codice fiscale (16 caratteri) o Partita IVA (11 cifre) valido trovato nella colonna selezionata' };
    }

    const job = this.jobRepo.create({
      status: DomicileVerificationJobStatus.QUEUED,
      totalRows: parsed.rows.length,
      sourceCsv: params.csvContent,
      csvHeaders: parsed.headers,
      cfColumn: params.cfColumn,
      hasHeaders: params.hasHeaders,
      ioServiceId: params.ioServiceId,
      cfFisicoTotal: cfFisici.length,
      pivaTotal: pive.length,
      inadBatches: [],
      inadFoundMap: {},
      appIoResults: {},
      registroImpreseResults: {},
      resultAssentiCsv: null,
      resultAppIoCsv: null,
      resultInadCsv: null,
      resultRegistroImpreseCsv: null,
      resultAggregatoCsv: null,
      errorMessage: null,
      completedAt: null,
    });
    const saved = await this.jobRepo.save(job);

    let attempts = 0;
    let succeeded = 0;
    let lastError: any = null;
    const partialFailures: string[] = [];

    if (cfFisici.length > 0) {
      attempts++;
      try {
        await this.appIoQueue.add('verify', { jobId: saved.id }, { jobId: saved.id });
        succeeded++;
      } catch (err: any) {
        lastError = err;
        partialFailures.push(`App IO non accodato: ${err.message}`);
        this.logger.warn(`Job ${saved.id}: enqueue App IO fallito: ${err.message}`);
      }

      const batches: DomicileInadBatch[] = [];
      let chunkIndex = 0;
      for (let i = 0; i < cfFisici.length; i += BATCH_SIZE) {
        chunkIndex++;
        attempts++;
        const chunk = cfFisici.slice(i, i + BATCH_SIZE);
        try {
          const { id } = await this.inadService.startBulkExtraction(chunk, `comunicapa-domicili-${saved.id}`);
          batches.push({ id, size: chunk.length, done: false });
          succeeded++;
        } catch (err: any) {
          lastError = err;
          partialFailures.push(`Batch INAD ${chunkIndex} fallito (${chunk.length} CF): ${err.message}`);
          this.logger.warn(`Job ${saved.id}: startBulkExtraction fallito per un chunk (${chunk.length} CF): ${err.message}`);
        }
      }
      await this.jobRepo.update(saved.id, { inadBatches: batches });
    }

    let pivaSucceeded = 0;
    for (const piva of pive) {
      attempts++;
      try {
        await this.registroImpreseQueue.enqueueVerify(saved.id, piva);
        succeeded++;
        pivaSucceeded++;
      } catch (err: any) {
        lastError = err;
        partialFailures.push(`PIVA ${piva} non accodata: ${err.message}`);
        this.logger.warn(`Job ${saved.id}: enqueueVerify fallito per PIVA ${piva}: ${err.message}`);
      }
    }

    // Registro Imprese subito su TUTTI i CF fisici, in parallelo a
    // INAD/App IO — non solo sui non-trovati-da-INAD. Registro Imprese è
    // rate-limited a 5/sec (stesso limite indipendentemente da quanti CF
    // si accodano), quindi aspettare l'esito INAD prima di iniziare non
    // fa risparmiare chiamate reali (INAD trova in media una minoranza
    // dei CF fisici, il residuo sarebbe quasi tutti comunque) — costa solo
    // tempo morto in sequenza. Nessun residuo da accodare più tardi nel
    // sync service: residualEnqueued parte già a true.
    let cfRegistroSucceeded = 0;
    for (const cf of cfFisici) {
      attempts++;
      try {
        await this.registroImpreseQueue.enqueueVerify(saved.id, cf);
        succeeded++;
        cfRegistroSucceeded++;
      } catch (err: any) {
        lastError = err;
        partialFailures.push(`CF ${cf} non accodato su Registro Imprese: ${err.message}`);
        this.logger.warn(`Job ${saved.id}: enqueueVerify fallito per CF ${cf}: ${err.message}`);
      }
    }

    if (attempts > 0 && succeeded === 0) {
      await this.jobRepo.update(saved.id, {
        status: DomicileVerificationJobStatus.FAILED,
        errorMessage: partialFailures.join('; ') || (lastError?.message ?? 'Errore sconosciuto'),
        completedAt: new Date(),
      });
    } else {
      await this.jobRepo.update(saved.id, {
        status: DomicileVerificationJobStatus.PROCESSING,
        registroImpreseTotal: pivaSucceeded + cfRegistroSucceeded,
        residualEnqueued: true,
        ...(partialFailures.length > 0 ? { errorMessage: partialFailures.join('; ') } : {}),
      });
    }

    return { jobId: saved.id };
  }

  async getStatus(jobId: string): Promise<DomicileVerificationStatus> {
    const job = await this.jobRepo.findOneBy({ id: jobId });
    if (!job) throw new NotFoundException(`Job di verifica ${jobId} non trovato`);
    return {
      status: job.status,
      totalRows: job.totalRows,
      cfFisicoTotal: job.cfFisicoTotal,
      pivaTotal: job.pivaTotal,
      inadBatchesTotal: job.inadBatches.length,
      inadBatchesDone: job.inadBatches.filter((b) => b.done).length,
      inadFoundCount: Object.keys(job.inadFoundMap).length,
      appIoDone: job.appIoDone,
      appIoProcessedRows: job.appIoProcessedRows,
      appIoPresentCount: job.appIoPresentCount,
      registroImpreseTotal: job.registroImpreseTotal,
      registroImpreseDone: job.registroImpreseDone,
      registroImpreseFoundCount: job.registroImpreseFoundCount,
      errorMessage: job.errorMessage,
    };
  }

  async listJobs(): Promise<DomicileVerificationJobSummary[]> {
    const jobs = await this.jobRepo.find({ order: { createdAt: 'DESC' }, take: 50 });
    return jobs.map((j) => ({
      id: j.id,
      status: j.status,
      createdAt: j.createdAt,
      totalRows: j.totalRows,
      cfFisicoTotal: j.cfFisicoTotal,
      pivaTotal: j.pivaTotal,
    }));
  }

  /**
   * Valvola di sfogo operatore: abbandona i batch INAD ancora pending
   * (marcati done, mai un risultato per i CF non ancora verificati — stessa
   * semantica del fallback anti-stallo 48h, ma su richiesta esplicita invece
   * che dopo un'attesa lunga). App IO/Registro Imprese non toccati: se non
   * sono ancora pronti, il job resta PROCESSING finché non lo sono anche
   * loro (DomicileVerificationSyncService li considera normalmente al
   * prossimo tick).
   */
  async skipInad(jobId: string): Promise<void> {
    const job = await this.jobRepo.findOneBy({ id: jobId });
    if (!job) throw new NotFoundException(`Job di verifica ${jobId} non trovato`);
    if (job.status !== DomicileVerificationJobStatus.PROCESSING) {
      throw new BadRequestException('Il job non è in elaborazione');
    }
    const inadBatches = job.inadBatches.map((b) => ({ ...b, done: true }));
    await this.jobRepo.update(jobId, { inadBatches, inadFetched: true });
  }

  async getResultCsv(jobId: string, variant: DomicileVerificationCsvVariant): Promise<string> {
    const job = await this.jobRepo.findOneBy({ id: jobId });
    if (!job) throw new NotFoundException(`Job di verifica ${jobId} non trovato`);
    if (job.status !== DomicileVerificationJobStatus.DONE) {
      throw new BadRequestException('Il job di verifica non è ancora completato');
    }
    const content = job[CSV_COLUMN_BY_VARIANT[variant]] as string | null;
    if (!content) throw new NotFoundException('Risultato non disponibile');
    return content;
  }
}
