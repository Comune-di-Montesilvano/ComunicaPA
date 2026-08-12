import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InadVerificationJob, InadVerificationJobStatus, InadVerificationBatch } from '../../entities/inad-verification-job.entity';
import { parseCsvContent } from '../../io-services/csv.util';
import { InadService } from './inad.service';
import { RegistroImpreseVerifyQueueService } from '../registro-imprese/registro-imprese-verify-queue.service';
import { isPartitaIva } from '../tax-id.util';

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
 *
 * Le righe a 11 cifre (Partita IVA) non vanno a INAD (nessun dato per
 * imprese) — vengono accodate su registro-imprese-verify (1 job BullMQ per
 * PIVA, rate limiter + backoff su 429). Il job resta PROCESSING finché
 * entrambe le fonti non sono complete (vedi InadVerifyBulkSyncService).
 */
@Injectable()
export class InadVerifyBulkService {
  private readonly logger = new Logger(InadVerifyBulkService.name);

  constructor(
    @InjectRepository(InadVerificationJob)
    private readonly jobRepo: Repository<InadVerificationJob>,
    private readonly inadService: InadService,
    private readonly registroImpreseQueue: RegistroImpreseVerifyQueueService,
  ) {}

  async createJob(params: CreateInadBulkVerifyParams): Promise<CreateInadBulkVerifyResult> {
    const parsed = parseCsvContent(params.csvContent, params.hasHeaders);
    if (parsed.rows.length === 0) {
      return { blocked: true, message: 'Il CSV caricato non contiene righe di dati' };
    }
    if (!parsed.headers.includes(params.cfColumn)) {
      return { blocked: true, message: `Colonna "${params.cfColumn}" non trovata tra le intestazioni del CSV` };
    }

    const rawValues = parsed.rows.map((row) => (row[params.cfColumn] || '').trim().toUpperCase());
    const validCfs = Array.from(new Set(rawValues.filter((v) => v.length === 16)));
    const pivaValues = Array.from(new Set(rawValues.filter((v) => isPartitaIva(v))));
    if (validCfs.length === 0 && pivaValues.length === 0) {
      return { blocked: true, message: 'Nessun codice fiscale (16 caratteri) o Partita IVA (11 cifre) valido trovato nella colonna selezionata' };
    }

    const job = this.jobRepo.create({
      status: InadVerificationJobStatus.QUEUED,
      totalRows: parsed.rows.length,
      batches: [],
      foundCount: 0,
      notFoundCount: 0,
      pivaTotal: pivaValues.length,
      pivaDone: 0,
      pivaFoundCount: 0,
      pivaResults: {},
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

    // Ogni chunk INAD e ogni PIVA vanno tentati indipendentemente: un fallimento
    // isolato (es. coda temporaneamente giù) non deve annullare il job intero e
    // orfanizzare i batch/enqueue già avviati con successo dalle iterazioni
    // precedenti, nello stesso loop o nell'altro.
    const chunkCount = Math.ceil(validCfs.length / BATCH_SIZE);
    const totalAttempts = chunkCount + pivaValues.length;
    let succeededAttempts = 0;
    let lastError: any = null;
    // Messaggi concisi per-chunk/per-lotto (non una riga per singolo CF/PIVA):
    // un fallimento parziale non porta il job a FAILED (c'è comunque lavoro
    // avviato con successo) ma va comunque segnalato, altrimenti gli
    // identificativi mai accodati spariscono silenziosamente nel CSV "non
    // trovati" come se fossero stati controllati davvero.
    const partialFailures: string[] = [];

    const batches: InadVerificationBatch[] = [];
    let chunkIndex = 0;
    for (let i = 0; i < validCfs.length; i += BATCH_SIZE) {
      chunkIndex++;
      const chunk = validCfs.slice(i, i + BATCH_SIZE);
      try {
        const { id } = await this.inadService.startBulkExtraction(chunk, `comunicapa-verifica-${saved.id}`);
        batches.push({ id, size: chunk.length, done: false });
        succeededAttempts++;
      } catch (err: any) {
        lastError = err;
        partialFailures.push(`Batch INAD ${chunkIndex} fallito (${chunk.length} CF): ${err.message}`);
        this.logger.warn(`Job ${saved.id}: startBulkExtraction fallito per un chunk (${chunk.length} CF): ${err.message}`);
      }
    }

    // pivaSucceeded è il conteggio REALE di PIVA effettivamente accodate su
    // BullMQ — mai il pivaTotal ottimistico calcolato prima del loop: se anche
    // una sola enqueueVerify fallisce, quella PIVA non avrà mai un processor
    // che incrementa piva_done, e pivaDone >= pivaTotal (il gate di
    // completamento in InadVerifyBulkSyncService) non diventerebbe mai vero.
    let pivaSucceeded = 0;
    let pivaFailedCount = 0;
    let lastPivaError: any = null;
    for (const piva of pivaValues) {
      try {
        await this.registroImpreseQueue.enqueueVerify(saved.id, piva);
        succeededAttempts++;
        pivaSucceeded++;
      } catch (err: any) {
        lastError = err;
        lastPivaError = err;
        pivaFailedCount++;
        this.logger.warn(`Job ${saved.id}: enqueueVerify fallito per PIVA ${piva}: ${err.message}`);
      }
    }
    if (pivaFailedCount > 0) {
      partialFailures.push(`${pivaFailedCount} Partite IVA non accodate: ${lastPivaError?.message ?? 'errore sconosciuto'}`);
    }

    if (totalAttempts > 0 && succeededAttempts === 0) {
      await this.jobRepo.update(saved.id, {
        status: InadVerificationJobStatus.FAILED,
        errorMessage: lastError?.message ?? 'Errore sconosciuto',
        completedAt: new Date(),
      });
    } else {
      await this.jobRepo.update(saved.id, {
        status: InadVerificationJobStatus.PROCESSING,
        batches,
        pivaTotal: pivaSucceeded,
        ...(partialFailures.length > 0 ? { errorMessage: partialFailures.join('; ') } : {}),
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
