import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { DomicileVerificationJob, DomicileVerificationJobStatus } from '../../entities/domicile-verification-job.entity.js';
import { InadService, InadQuotaExceededError, resolveInadDigitalAddress } from '../inad/inad.service.js';
import { buildDomicileVerificationCsvs } from './domicile-verification-csv.util.js';
import { DomicileVerificationEventsService } from './domicile-verification-events.service.js';
import { AnprMassivoService } from '../anpr/anpr-massivo.service.js';
import { errorMessage } from '../../common/error-message.js';

/** Rete di sicurezza: un job bloccato oltre questa soglia (una fonte mai
 * completa per un bug non ancora scoperto) va chiuso esplicitamente FAILED
 * invece di restare in PROCESSING per sempre — stesso principio già in uso
 * su InadVerifyBulkSyncService. Esteso da 24 a 48h: una campagna reale ha
 * atteso oltre 24h per colpa della sola quota giornaliera INAD (comunque
 * mai soggetta a questo timeout, vedi sotto) — margine di sicurezza più
 * ampio per i casi genuinamente bloccati (bug, non quota). */
const STALE_AFTER_HOURS = 48;

/** Elaborazioni massive ANPR: fino a 3 giorni per doc ufficiale, più margine. */
const ANPR_STALE_AFTER_HOURS = 96;

/** Download ANPR riprovato al massimo ogni 10 minuti (esito in ore/giorni). */
const ANPR_POLL_INTERVAL_MS = 10 * 60_000;

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
    private readonly anprMassivo: AnprMassivoService,
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
      await this.jobRepo.update({ id: job.id, status: DomicileVerificationJobStatus.PROCESSING }, {
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
    const anpr = await this.syncAnpr(job);
    if (anpr.changed) {
      patch.anprRequests = anpr.requests;
      patch.anprResults = anpr.results;
      patch.anprVitaResults = anpr.vitaResults;
    }
    const complete = inadAllReady && inadFetched && appIoReady && registroImpreseReady && anpr.ready;

    if (!complete) {
      const ageHours = (Date.now() - new Date(job.createdAt).getTime()) / 3_600_000;
      // Con ANPR ancora pendente vale la soglia lunga: l'elaborazione massiva
      // può legittimamente durare fino a 3 giorni.
      const staleAfter = anpr.ready ? STALE_AFTER_HOURS : ANPR_STALE_AFTER_HOURS;
      if (!quotaBlocked && ageHours > staleAfter) {
        await this.jobRepo.update({ id: job.id, status: DomicileVerificationJobStatus.PROCESSING }, {
          ...patch,
          status: DomicileVerificationJobStatus.FAILED,
          errorMessage: `Verifica interrotta: non completata entro ${staleAfter}h (INAD pronto: ${inadAllReady}, App IO pronto: ${appIoReady}, Registro Imprese ${job.registroImpreseDone}/${job.registroImpreseTotal}, ANPR pronto: ${anpr.ready}${anpr.lastResponse ? ` — ultima risposta ANPR: ${anpr.lastResponse}` : ''}).`,
          completedAt: new Date(),
        });
        this.logger.warn(`DomicileVerificationJob ${job.id} marcato FAILED per stallo (>${staleAfter}h in PROCESSING).`);
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
      registroImpreseFoundMap: job.registroImpreseFoundMap ?? {},
      anprResults: anpr.results,
      anprVitaResults: anpr.vitaResults,
    });

    // Condizionato a PROCESSING: un annullamento arrivato durante questo
    // giro non viene sovrascritto da DONE.
    await this.jobRepo.update({ id: job.id, status: DomicileVerificationJobStatus.PROCESSING }, {
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

  /**
   * Prova a scaricare gli esiti ANPR ancora pendenti (al massimo ogni
   * ANPR_POLL_INTERVAL_MS per richiesta). Un errore ANPR non fa mai fallire
   * il job: resta pendente, con l'ultima risposta salvata per la diagnosi,
   * fino all'esito, allo "Salta ANPR" dell'admin o alla soglia di stallo.
   */
  private async syncAnpr(job: DomicileVerificationJob): Promise<{
    ready: boolean;
    changed: boolean;
    requests: DomicileVerificationJob['anprRequests'];
    results: Record<string, boolean>;
    vitaResults: Record<string, 'S' | 'N' | null>;
    lastResponse?: string;
  }> {
    const requests = (job.anprRequests ?? []).map((r) => ({ ...r }));
    const results = { ...(job.anprResults ?? {}) };
    const vitaResults = { ...(job.anprVitaResults ?? {}) };
    let changed = false;
    let lastResponse: string | undefined;
    const now = Date.now();

    for (const req of requests) {
      if (req.done) continue;
      if (req.lastPolledAt && now - new Date(req.lastPolledAt).getTime() < ANPR_POLL_INTERVAL_MS) {
        lastResponse = req.lastResponse;
        continue;
      }
      changed = true;
      req.lastPolledAt = new Date(now).toISOString();
      try {
        const res = await this.anprMassivo.download(req.kind, req.id, job.createdBy ?? 'comunicapa');
        if (!res.ready) {
          req.lastResponse = res.detail;
          lastResponse = res.detail;
          continue;
        }
        for (const cf of req.cfs) {
          const esito = res.esiti.get(cf);
          if (req.kind === 'id') {
            results[cf] = !!esito;
          } else if (!esito) {
            vitaResults[cf] = null;
          } else if (esito.esistenzaInVita) {
            vitaResults[cf] = esito.esistenzaInVita;
          }
          // presente ma senza S/N: esito sconosciuto, nessuna voce
        }
        req.done = true;
        req.lastResponse = undefined;
      } catch (err) {
        req.lastResponse = errorMessage(err);
        lastResponse = req.lastResponse;
        this.logger.warn(`DomicileVerificationJob ${job.id}: download ANPR ${req.kind} ${req.id} fallito: ${req.lastResponse}`);
      }
    }
    return { ready: requests.every((r) => r.done), changed, requests, results, vitaResults, lastResponse };
  }
}
