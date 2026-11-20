import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import type { OperatorRole } from '@comunicapa/shared-types';
import {
  DomicileVerificationJob,
  DomicileVerificationJobStatus,
  DomicileInadBatch,
  DomicileAnprRequest,
} from '../../entities/domicile-verification-job.entity.js';
import { IoServiceConfig } from '../../entities/io-service-config.entity.js';
import { parseCsvContent } from '../../io-services/csv.util.js';
import { APP_IO_VERIFY_BULK_QUEUE, AppIoVerifyBulkJobData } from '../../io-services/app-io-verify-bulk-job.types.js';
import { InadService } from '../inad/inad.service.js';
import { RegistroImpreseVerifyQueueService } from '../registro-imprese/registro-imprese-verify-queue.service.js';
import { checkTaxId } from '../tax-id.util.js';
import { errorMessage } from '../../common/error-message.js';
import { AnprMassivoService, AnprMassivoKind, ANPR_MASSIVO_CHUNK_SIZE } from '../anpr/anpr-massivo.service.js';

const BATCH_SIZE = 1000;

const ANPR_KIND_LABEL: Record<AnprMassivoKind, string> = {
  id: 'presenza in ANPR',
  vita: 'esistenza in vita',
};

export interface CreateDomicileVerificationJobParams {
  csvContent: string;
  hasHeaders: boolean;
  cfColumn: string;
  ioServiceId: string;
  /** Username dell'operatore che carica il tracciato (proprietario del job). */
  createdBy: string;
  /** Verifica presenza CF in ANPR (C030, elaborazione massiva fino a 3 giorni). */
  anprId?: boolean;
  /** Verifica esistenza in vita (C007, elaborazione massiva fino a 3 giorni). */
  anprVita?: boolean;
}

export interface DomicileVerificationOptions {
  anprIdAvailable: boolean;
  anprVitaAvailable: boolean;
}

/** Chi chiede: un 'user' vede e cancella solo i propri job, un 'admin' tutti. */
export interface DomicileVerificationRequester {
  username: string;
  role: OperatorRole;
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
  anprIdRequested: boolean;
  anprVitaRequested: boolean;
  anprRequestsTotal: number;
  anprRequestsDone: number;
  /** CF verificati non presenti in ANPR (C030 o C007). */
  anprNotFoundCount: number;
  /** CF con esistenza in vita = N (C007). */
  anprDeceasedCount: number;
  errorMessage: string | null;
}

export interface DomicileVerificationJobSummary {
  id: string;
  status: DomicileVerificationJobStatus;
  createdAt: Date;
  totalRows: number;
  cfFisicoTotal: number;
  pivaTotal: number;
  createdBy: string | null;
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
    private readonly anprMassivo: AnprMassivoService,
  ) {}

  /** Opzioni facoltative disponibili al caricamento (ANPR solo se configurato). */
  async getOptions(): Promise<DomicileVerificationOptions> {
    const [anprIdAvailable, anprVitaAvailable] = await Promise.all([
      this.anprMassivo.isConfigured('id'),
      this.anprMassivo.isConfigured('vita'),
    ]);
    return { anprIdAvailable, anprVitaAvailable };
  }

  async createJob(params: CreateDomicileVerificationJobParams): Promise<CreateDomicileVerificationJobResult> {
    const service = await this.ioServiceRepo.findOneBy({ id: params.ioServiceId });
    if (!service) {
      return { blocked: true, message: 'Servizio App IO selezionato non trovato' };
    }
    // C007 (esistenza in vita) restituisce già anche "non presente in ANPR"
    // (CF assente dall'output, stessa regola di C030): con l'esistenza in
    // vita richiesta basta una sola elaborazione, C030 solo da solo.
    const anprKinds: AnprMassivoKind[] = params.anprVita ? ['vita'] : params.anprId ? ['id'] : [];
    for (const kind of anprKinds) {
      if (!(await this.anprMassivo.isConfigured(kind))) {
        return { blocked: true, message: `Verifica ANPR (${ANPR_KIND_LABEL[kind]}) non configurata: manca il Purpose ID in Impostazioni → ANPR` };
      }
    }

    const parsed = parseCsvContent(params.csvContent, params.hasHeaders);
    if (parsed.rows.length === 0) {
      return { blocked: true, message: 'Il CSV caricato non contiene righe di dati' };
    }
    if (!parsed.headers.includes(params.cfColumn)) {
      return { blocked: true, message: `Colonna "${params.cfColumn}" non trovata tra le intestazioni del CSV` };
    }

    // Controllo formale (carattere di controllo CF, cifra di controllo PIVA):
    // i valori non validi non vanno a nessun servizio esterno, l'errore
    // finisce nella colonna "errori" del report aggregato.
    const checks = parsed.rows.map((row) => checkTaxId(row[params.cfColumn] || ''));
    const cfFisici = Array.from(new Set(checks.filter((c) => c.kind === 'cf').map((c) => c.value)));
    const pive = Array.from(new Set(checks.filter((c) => c.kind === 'piva').map((c) => c.value)));
    if (cfFisici.length === 0 && pive.length === 0) {
      return { blocked: true, message: 'Nessun codice fiscale o Partita IVA formalmente valido (carattere di controllo corretto) nella colonna selezionata' };
    }

    const job = this.jobRepo.create({
      status: DomicileVerificationJobStatus.QUEUED,
      totalRows: parsed.rows.length,
      sourceCsv: params.csvContent,
      csvHeaders: parsed.headers,
      cfColumn: params.cfColumn,
      hasHeaders: params.hasHeaders,
      ioServiceId: params.ioServiceId,
      createdBy: params.createdBy,
      cfFisicoTotal: cfFisici.length,
      pivaTotal: pive.length,
      inadBatches: [],
      inadFoundMap: {},
      appIoResults: {},
      registroImpreseResults: {},
      registroImpreseFoundMap: {},
      // Presenza in ANPR verificata anche dalla sola C007.
      anprIdRequested: anprKinds.length > 0,
      anprVitaRequested: anprKinds.includes('vita'),
      anprRequests: [],
      anprResults: {},
      anprVitaResults: {},
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
    let lastError: unknown = null;
    const partialFailures: string[] = [];

    if (cfFisici.length > 0) {
      attempts++;
      try {
        await this.appIoQueue.add('verify', { jobId: saved.id }, { jobId: saved.id });
        succeeded++;
      } catch (err) {
        lastError = err;
        partialFailures.push(`App IO non accodato: ${errorMessage(err)}`);
        this.logger.warn(`Job ${saved.id}: enqueue App IO fallito: ${errorMessage(err)}`);
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
        } catch (err) {
          lastError = err;
          partialFailures.push(`Batch INAD ${chunkIndex} fallito (${chunk.length} CF): ${errorMessage(err)}`);
          this.logger.warn(`Job ${saved.id}: startBulkExtraction fallito per un chunk (${chunk.length} CF): ${errorMessage(err)}`);
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
      } catch (err) {
        lastError = err;
        partialFailures.push(`PIVA ${piva} non accodata: ${errorMessage(err)}`);
        this.logger.warn(`Job ${saved.id}: enqueueVerify fallito per PIVA ${piva}: ${errorMessage(err)}`);
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
      } catch (err) {
        lastError = err;
        partialFailures.push(`CF ${cf} non accodato su Registro Imprese: ${errorMessage(err)}`);
        this.logger.warn(`Job ${saved.id}: enqueueVerify fallito per CF ${cf}: ${errorMessage(err)}`);
      }
    }

    // ANPR (facoltativo): elaborazioni massive asincrone, una richiesta per
    // blocco di CF. Un blocco non accodato lascia quei CF "non verificati"
    // (nessun errore per riga), il problema finisce in errorMessage.
    if (cfFisici.length > 0 && anprKinds.length > 0) {
      const anprRequests: DomicileAnprRequest[] = [];
      for (const kind of anprKinds) {
        for (let i = 0; i < cfFisici.length; i += ANPR_MASSIVO_CHUNK_SIZE) {
          attempts++;
          const chunk = cfFisici.slice(i, i + ANPR_MASSIVO_CHUNK_SIZE);
          try {
            const id = await this.anprMassivo.start(kind, chunk, `ComunicaPA verifica domicili ${saved.id.slice(0, 8)}`, params.createdBy);
            anprRequests.push({ kind, id, cfs: chunk, done: false });
            succeeded++;
          } catch (err) {
            lastError = err;
            partialFailures.push(`ANPR (${ANPR_KIND_LABEL[kind]}) non avviato per ${chunk.length} CF: ${errorMessage(err)}`);
            this.logger.warn(`Job ${saved.id}: richiesta ANPR massiva ${kind} fallita (${chunk.length} CF): ${errorMessage(err)}`);
          }
        }
      }
      await this.jobRepo.update(saved.id, { anprRequests });
    }

    if (attempts > 0 && succeeded === 0) {
      await this.jobRepo.update(saved.id, {
        status: DomicileVerificationJobStatus.FAILED,
        errorMessage: partialFailures.join('; ') || (lastError != null ? errorMessage(lastError) : 'Errore sconosciuto'),
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

  /**
   * Job visibile a chi chiede: un 'user' trova solo i propri, quindi un job
   * altrui risponde 404 come se non esistesse (non se ne rivela nemmeno
   * l'esistenza). I job senza proprietario (precedenti al campo) solo admin.
   */
  private async findVisibleJob(jobId: string, requester: DomicileVerificationRequester): Promise<DomicileVerificationJob> {
    const where = requester.role === 'admin' ? { id: jobId } : { id: jobId, createdBy: requester.username };
    const job = await this.jobRepo.findOneBy(where);
    if (!job) throw new NotFoundException(`Job di verifica ${jobId} non trovato`);
    return job;
  }

  async getStatus(jobId: string, requester: DomicileVerificationRequester): Promise<DomicileVerificationStatus> {
    const job = await this.findVisibleJob(jobId, requester);
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
      anprIdRequested: job.anprIdRequested ?? false,
      anprVitaRequested: job.anprVitaRequested ?? false,
      anprRequestsTotal: (job.anprRequests ?? []).length,
      anprRequestsDone: (job.anprRequests ?? []).filter((r) => r.done).length,
      anprNotFoundCount: new Set([
        ...Object.entries(job.anprResults ?? {}).filter(([, v]) => v === false).map(([k]) => k),
        ...Object.entries(job.anprVitaResults ?? {}).filter(([, v]) => v === null).map(([k]) => k),
      ]).size,
      anprDeceasedCount: Object.values(job.anprVitaResults ?? {}).filter((v) => v === 'N').length,
      errorMessage: job.errorMessage,
    };
  }

  async listJobs(requester: DomicileVerificationRequester): Promise<DomicileVerificationJobSummary[]> {
    const jobs = await this.jobRepo.find({
      where: requester.role === 'admin' ? {} : { createdBy: requester.username },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    return jobs.map((j) => ({
      id: j.id,
      status: j.status,
      createdAt: j.createdAt,
      totalRows: j.totalRows,
      cfFisicoTotal: j.cfFisicoTotal,
      pivaTotal: j.pivaTotal,
      createdBy: j.createdBy,
    }));
  }

  /**
   * Cancellazione dallo storico (proprietario o admin). Mai un job in
   * elaborazione: i worker App IO/Registro Imprese e il sync INAD lo
   * aggiornano ancora — stessa esclusione della retention automatica.
   */
  async deleteJob(jobId: string, requester: DomicileVerificationRequester): Promise<void> {
    const job = await this.findVisibleJob(jobId, requester);
    if (job.status === DomicileVerificationJobStatus.PROCESSING) {
      throw new BadRequestException('Il job è in elaborazione: si può eliminare solo a verifica conclusa');
    }
    await this.jobRepo.delete(job.id);
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

  /**
   * Come skipInad, per le elaborazioni massive ANPR (fino a 3 giorni): le
   * richieste non ancora scaricate vengono abbandonate, i loro CF restano
   * "non verificati" (nessun errore ANPR nel report).
   */
  async skipAnpr(jobId: string): Promise<void> {
    const job = await this.jobRepo.findOneBy({ id: jobId });
    if (!job) throw new NotFoundException(`Job di verifica ${jobId} non trovato`);
    if (job.status !== DomicileVerificationJobStatus.PROCESSING) {
      throw new BadRequestException('Il job non è in elaborazione');
    }
    const anprRequests = (job.anprRequests ?? []).map((r) => ({ ...r, done: true }));
    await this.jobRepo.update(jobId, { anprRequests });
  }

  async getResultCsv(jobId: string, variant: DomicileVerificationCsvVariant, requester: DomicileVerificationRequester): Promise<string> {
    const job = await this.findVisibleJob(jobId, requester);
    if (job.status !== DomicileVerificationJobStatus.DONE) {
      throw new BadRequestException('Il job di verifica non è ancora completato');
    }
    const content = job[CSV_COLUMN_BY_VARIANT[variant]] as string | null;
    if (!content) throw new NotFoundException('Risultato non disponibile');
    return content;
  }
}
