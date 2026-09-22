import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DomicileVerificationJob, DomicileVerificationJobStatus } from '../entities/domicile-verification-job.entity.js';
import { IoServiceConfig } from '../entities/io-service-config.entity.js';
import { IoServicesService } from './io-services.service.js';
import { parseCsvContent } from './csv.util.js';
import { APP_IO_VERIFY_BULK_QUEUE, AppIoVerifyBulkJobData } from './app-io-verify-bulk-job.types.js';
import { DomicileVerificationEventsService } from '../channels/domicile-verification/domicile-verification-events.service.js';

const PROGRESS_UPDATE_EVERY = 25;
const CONCURRENCY = 5;

/** Stessa convenzione già usata in App.tsx per la verifica singola: un
 * profilo con messaggi disabilitati per questo servizio non è "presente"
 * ai fini di un successivo invio reale. */
export function isPresentResult(result: { success: boolean; active: boolean; message: string }): boolean {
  return result.success && result.active && !result.message.includes('disabilitati');
}

/**
 * Job unico sull'intero CSV del DomicileVerificationJob (App IO non ha un
 * equivalente del batch INAD — un profilo alla volta via verifyProfile) —
 * scrive SOLO i campi app_io_* del job padre, mai lo status complessivo
 * (deciso da DomicileVerificationSyncService in base a tutte e 3 le fonti).
 * Un errore hard (servizio App IO selezionato non trovato/senza chiave) fa
 * fallire l'intero job padre: senza quel servizio non è possibile
 * verificare nessun CF, non ha senso proseguire con le altre fonti.
 */
@Injectable()
@Processor(APP_IO_VERIFY_BULK_QUEUE)
export class AppIoVerifyBulkProcessor extends WorkerHost {
  private readonly logger = new Logger(AppIoVerifyBulkProcessor.name);

  constructor(
    @InjectRepository(DomicileVerificationJob)
    private readonly jobRepo: Repository<DomicileVerificationJob>,
    @InjectRepository(IoServiceConfig)
    private readonly ioServiceRepo: Repository<IoServiceConfig>,
    private readonly ioServices: IoServicesService,
    private readonly domicileEvents: DomicileVerificationEventsService,
  ) {
    super();
  }

  async process(job: Job<AppIoVerifyBulkJobData>): Promise<void> {
    const { jobId } = job.data;
    const record = await this.jobRepo.findOneBy({ id: jobId });
    if (!record) {
      this.logger.warn(`DomicileVerificationJob ${jobId} non trovato — job App IO scartato`);
      return;
    }

    try {
      const service = await this.ioServiceRepo.findOneBy({ id: record.ioServiceId });
      if (!service || !service.apiKeyPrimariaEnc) {
        throw new Error(`Servizio App IO selezionato (${record.ioServiceId}) non trovato o senza chiave API configurata`);
      }

      const parsed = parseCsvContent(record.sourceCsv, record.hasHeaders);
      const results: Record<string, boolean> = {};
      let processed = 0;
      let present = 0;
      let absent = 0;

      const runRow = async (row: Record<string, string>) => {
        const cf = (row[record.cfColumn] || '').trim().toUpperCase();
        if (cf.length === 16) {
          let isPresent: boolean;
          try {
            const result = await this.ioServices.verifyProfile(cf, record.ioServiceId);
            isPresent = isPresentResult(result);
          } catch {
            // Errore non gestito da verifyProfile (es. servizio eliminato a
            // metà job): stesso trattamento degli errori di rete, la riga
            // finisce tra gli assenti, il job intero non fallisce per questo.
            isPresent = false;
          }
          results[cf] = isPresent;
          if (isPresent) present++; else absent++;
        }
        processed += 1;
        if (processed % PROGRESS_UPDATE_EVERY === 0) {
          await this.jobRepo.update(jobId, { appIoProcessedRows: processed });
        }
      };

      for (let i = 0; i < parsed.rows.length; i += CONCURRENCY) {
        const batch = parsed.rows.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(runRow));
      }

      await this.jobRepo.update(jobId, {
        appIoDone: true,
        appIoProcessedRows: parsed.rows.length,
        appIoPresentCount: present,
        appIoAbsentCount: absent,
        appIoResults: results,
      });
      this.logger.log(`DomicileVerificationJob ${jobId}: App IO completato — ${present} presenti, ${absent} assenti`);
      // Trigger immediato — stesso motivo del Registro Imprese: senza
      // questo, se INAD/Registro Imprese erano già pronti, il job padre
      // resta PROCESSING fino al prossimo tick cron.
      this.domicileEvents.notifyJobProgress(jobId);
    } catch (err: any) {
      this.logger.error(`DomicileVerificationJob ${jobId}: App IO fallito, job intero marcato FAILED — ${err.message}`);
      await this.jobRepo.update(jobId, {
        status: DomicileVerificationJobStatus.FAILED,
        errorMessage: err.message,
        completedAt: new Date(),
      });
    }
  }
}
