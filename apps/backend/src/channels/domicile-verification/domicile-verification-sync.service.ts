import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { DomicileVerificationJob, DomicileVerificationJobStatus } from '../../entities/domicile-verification-job.entity.js';
import { parseCsvContent } from '../../io-services/csv.util.js';
import { InadService, resolveInadDigitalAddress } from '../inad/inad.service.js';
import { RegistroImpreseVerifyQueueService } from '../registro-imprese/registro-imprese-verify-queue.service.js';
import { buildDomicileVerificationCsvs } from './domicile-verification-csv.util.js';
import { DomicileVerificationEventsService } from './domicile-verification-events.service.js';

const CF_FISICO_LENGTH = 16;

/** Rete di sicurezza: un job bloccato oltre questa soglia (una fonte mai
 * completa per un bug non ancora scoperto) va chiuso esplicitamente FAILED
 * invece di restare in PROCESSING per sempre — stesso principio già in uso
 * su InadVerifyBulkSyncService. */
const STALE_AFTER_HOURS = 24;

/**
 * Poll periodico dei 3 job PROCESSING — un job è completo solo quando TUTTE
 * e 3 le fonti lo sono: INAD (batch pronti + fetch fatto), App IO (job
 * singolo con appIoDone), Registro Imprese (registroImpreseDone >=
 * registroImpreseTotal, MA solo dopo che il residuo sui CF fisici non
 * trovati da INAD è stato accodato — residualEnqueued — altrimenti il gate
 * potrebbe risultare vero prematuramente con registroImpreseTotal ancora
 * al solo conteggio PIVA).
 */
@Injectable()
export class DomicileVerificationSyncService {
  private readonly logger = new Logger(DomicileVerificationSyncService.name);

  constructor(
    @InjectRepository(DomicileVerificationJob)
    private readonly jobRepo: Repository<DomicileVerificationJob>,
    private readonly inadService: InadService,
    private readonly registroImpreseQueue: RegistroImpreseVerifyQueueService,
    private readonly domicileEvents: DomicileVerificationEventsService,
  ) {
    // Trigger immediato quando App IO/Registro Imprese completano — senza
    // questo l'ultima fonte a chiudersi resta invisibile fino al prossimo
    // tick cron (fino a 5 minuti sprecati anche se tutto è già pronto).
    this.domicileEvents.onJobProgress((jobId) => {
      this.checkJobById(jobId).catch((err) => {
        this.logger.warn(`Errore check on-demand DomicileVerificationJob ${jobId}: ${err instanceof Error ? err.message : err}`);
      });
    });
  }

  async checkJobById(jobId: string): Promise<void> {
    const job = await this.jobRepo.findOneBy({ id: jobId });
    if (!job || job.status !== DomicileVerificationJobStatus.PROCESSING) return;
    await this.trySyncOne(job);
  }

  @Cron('*/5 * * * *')
  async handleCron(): Promise<void> {
    const jobs = await this.jobRepo.find({ where: { status: DomicileVerificationJobStatus.PROCESSING } });
    for (const job of jobs) {
      await this.trySyncOne(job);
    }
  }

  private async trySyncOne(job: DomicileVerificationJob): Promise<void> {
    try {
      await this.syncOne(job);
    } catch (err) {
      this.logger.warn(`Errore sync DomicileVerificationJob ${job.id}: ${err instanceof Error ? err.message : err}`);
      await this.jobRepo.update(job.id, {
        status: DomicileVerificationJobStatus.FAILED,
        errorMessage: err instanceof Error ? err.message : 'Errore sconosciuto',
        completedAt: new Date(),
      });
    }
  }

  private async syncOne(job: DomicileVerificationJob): Promise<void> {
    const batches = job.inadBatches;
    for (const batch of batches) {
      if (batch.done) continue;
      const state = await this.inadService.getBulkState(batch.id);
      if (state === 'DISPONIBILE') batch.done = true;
    }
    const inadAllReady = batches.every((b) => b.done);

    const patch: Partial<DomicileVerificationJob> = { inadBatches: batches };

    let inadFoundMap = job.inadFoundMap;
    let inadFetched = job.inadFetched;
    if (inadAllReady && !inadFetched) {
      const map: Record<string, string> = {};
      for (const batch of batches) {
        const items = await this.inadService.getBulkResult(batch.id);
        items.forEach((item) => {
          // Stessa risoluzione di campaigns.service.ts runInadExtractLoop
          // (resolveInadDigitalAddress, sempre il primo elemento) — prima
          // qui si univano TUTTI gli indirizzi con "; ", stesso dato
          // interpretato diversamente in due punti del codice.
          const address = resolveInadDigitalAddress(item.digitalAddress);
          if (address) map[item.codiceFiscale.toUpperCase()] = address;
        });
      }
      inadFoundMap = map;
      inadFetched = true;
      patch.inadFoundMap = inadFoundMap;
      patch.inadFetched = true;
    }

    let residualEnqueued = job.residualEnqueued;
    let registroImpreseTotal = job.registroImpreseTotal;
    if (inadAllReady && inadFetched && !residualEnqueued) {
      const parsed = parseCsvContent(job.sourceCsv, job.hasHeaders);
      const cfFisici = Array.from(new Set(
        parsed.rows
          .map((row) => (row[job.cfColumn] || '').trim().toUpperCase())
          .filter((cf) => cf.length === CF_FISICO_LENGTH),
      ));
      const residuo = cfFisici.filter((cf) => inadFoundMap[cf] === undefined);
      let enqueued = 0;
      for (const cf of residuo) {
        try {
          await this.registroImpreseQueue.enqueueVerify(job.id, cf);
          enqueued++;
        } catch (err: any) {
          this.logger.warn(`Job ${job.id}: enqueue residuo Registro Imprese fallito per ${cf}: ${err.message}`);
        }
      }
      registroImpreseTotal = job.registroImpreseTotal + enqueued;
      residualEnqueued = true;
      patch.residualEnqueued = true;
      patch.registroImpreseTotal = registroImpreseTotal;
    }

    const appIoReady = job.cfFisicoTotal === 0 || job.appIoDone;
    const registroImpreseReady = residualEnqueued && job.registroImpreseDone >= registroImpreseTotal;
    const complete = inadAllReady && inadFetched && appIoReady && registroImpreseReady;

    if (!complete) {
      const ageHours = (Date.now() - new Date(job.createdAt as any).getTime()) / 3_600_000;
      if (ageHours > STALE_AFTER_HOURS) {
        await this.jobRepo.update(job.id, {
          ...patch,
          status: DomicileVerificationJobStatus.FAILED,
          errorMessage: `Verifica interrotta: non completata entro ${STALE_AFTER_HOURS}h (INAD pronto: ${inadAllReady}, App IO pronto: ${appIoReady}, Registro Imprese ${job.registroImpreseDone}/${registroImpreseTotal}).`,
          completedAt: new Date(),
        });
        this.logger.warn(`DomicileVerificationJob ${job.id} marcato FAILED per stallo (>${STALE_AFTER_HOURS}h in PROCESSING).`);
        return;
      }
      await this.jobRepo.update(job.id, patch);
      return;
    }

    const csvs = buildDomicileVerificationCsvs({
      sourceCsv: job.sourceCsv,
      hasHeaders: job.hasHeaders,
      cfColumn: job.cfColumn,
      inadFoundMap,
      appIoResults: job.appIoResults,
      registroImpreseResults: job.registroImpreseResults,
    });

    await this.jobRepo.update(job.id, {
      ...patch,
      status: DomicileVerificationJobStatus.DONE,
      resultAssentiCsv: csvs.assentiCsv,
      resultAppIoCsv: csvs.appIoCsv,
      resultInadCsv: csvs.inadCsv,
      resultRegistroImpreseCsv: csvs.registroImpreseCsv,
      resultAggregatoCsv: csvs.aggregatoCsv,
      completedAt: new Date(),
    });
    this.logger.log(`DomicileVerificationJob ${job.id} completato`);
  }
}
