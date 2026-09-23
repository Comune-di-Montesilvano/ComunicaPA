import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { DomicileVerificationJob, DomicileVerificationJobStatus } from '../../entities/domicile-verification-job.entity.js';
import { InadService, InadQuotaExceededError, resolveInadDigitalAddress } from '../inad/inad.service.js';
import { buildDomicileVerificationCsvs } from './domicile-verification-csv.util.js';
import { DomicileVerificationEventsService } from './domicile-verification-events.service.js';

/** Rete di sicurezza: un job bloccato oltre questa soglia (una fonte mai
 * completa per un bug non ancora scoperto) va chiuso esplicitamente FAILED
 * invece di restare in PROCESSING per sempre — stesso principio già in uso
 * su InadVerifyBulkSyncService. Esteso da 24 a 48h: una campagna reale ha
 * atteso oltre 24h per colpa della sola quota giornaliera INAD (comunque
 * mai soggetta a questo timeout, vedi sotto) — margine di sicurezza più
 * ampio per i casi genuinamente bloccati (bug, non quota). */
const STALE_AFTER_HOURS = 48;

/**
 * Poll periodico dei job PROCESSING — un job è completo solo quando TUTTE e
 * 3 le fonti lo sono: INAD (batch pronti + fetch fatto), App IO (job
 * singolo con appIoDone), Registro Imprese (registroImpreseDone >=
 * registroImpreseTotal — accodato per intero già a creazione job, in
 * parallelo a INAD/App IO, mai un residuo da accodare qui).
 */
@Injectable()
export class DomicileVerificationSyncService {
  private readonly logger = new Logger(DomicileVerificationSyncService.name);

  constructor(
    @InjectRepository(DomicileVerificationJob)
    private readonly jobRepo: Repository<DomicileVerificationJob>,
    private readonly inadService: InadService,
    private readonly domicileEvents: DomicileVerificationEventsService,
  ) {
    // Trigger immediato quando App IO/Registro Imprese completano — senza
    // questo l'ultima fonte a chiudersi resta invisibile fino al prossimo
    // tick cron (fino a 1 minuto sprecato anche se tutto è già pronto).
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

  @Cron('* * * * *')
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
    // Quota giornaliera INAD esaurita (401): non deve mai far fallire il job
    // (era il bug reale — un solo 401 su getBulkState marcava FAILED per
    // sempre entro 5 minuti dal lancio, vedi CLAUDE.md). Batch resta
    // done:false, si riprova al prossimo tick — e quotaBlocked disattiva
    // anche il fallback anti-stallo (sotto) per questo giro, un blocco solo
    // di quota non deve mai contare come "stallo genuino".
    let quotaBlocked = false;
    for (const batch of batches) {
      if (batch.done) continue;
      try {
        const state = await this.inadService.getBulkState(batch.id);
        if (state === 'DISPONIBILE') batch.done = true;
      } catch (err) {
        if (!(err instanceof InadQuotaExceededError)) throw err;
        quotaBlocked = true;
      }
    }
    const inadAllReady = batches.every((b) => b.done);

    const patch: Partial<DomicileVerificationJob> = { inadBatches: batches };

    let inadFoundMap = job.inadFoundMap;
    let inadFetched = job.inadFetched;
    if (inadAllReady && !inadFetched) {
      const map: Record<string, string> = {};
      try {
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
      } catch (err) {
        if (!(err instanceof InadQuotaExceededError)) throw err;
        quotaBlocked = true;
        // inadFetched resta false: ritenteremo il fetch completo al
        // prossimo tick (nessun risultato parziale persistito).
      }
    }

    // Registro Imprese è accodato per intero (PIVA + tutti i CF fisici) già
    // a creazione job (DomicileVerificationService.createJob), in parallelo
    // a INAD/App IO — nessun residuo da accodare qui. registroImpreseTotal
    // non cambia più dopo la creazione.
    const appIoReady = job.cfFisicoTotal === 0 || job.appIoDone;
    const registroImpreseReady = job.registroImpreseDone >= job.registroImpreseTotal;
    const complete = inadAllReady && inadFetched && appIoReady && registroImpreseReady;

    if (!complete) {
      const ageHours = (Date.now() - new Date(job.createdAt as any).getTime()) / 3_600_000;
      if (!quotaBlocked && ageHours > STALE_AFTER_HOURS) {
        await this.jobRepo.update(job.id, {
          ...patch,
          status: DomicileVerificationJobStatus.FAILED,
          errorMessage: `Verifica interrotta: non completata entro ${STALE_AFTER_HOURS}h (INAD pronto: ${inadAllReady}, App IO pronto: ${appIoReady}, Registro Imprese ${job.registroImpreseDone}/${job.registroImpreseTotal}).`,
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
