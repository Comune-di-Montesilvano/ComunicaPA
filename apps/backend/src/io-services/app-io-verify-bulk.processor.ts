import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppIoVerificationJob, AppIoVerificationJobStatus } from '../entities/app-io-verification-job.entity';
import { IoServicesService } from './io-services.service';
import { parseCsvContent, buildCsvContent } from './csv.util';
import { APP_IO_VERIFY_BULK_QUEUE, AppIoVerifyBulkJobData } from './app-io-verify-bulk-job.types';

const PROGRESS_UPDATE_EVERY = 25;
const CONCURRENCY = 5;

/** Stessa convenzione già usata in App.tsx per la verifica singola: un
 * profilo con messaggi disabilitati per questo servizio non è "presente"
 * ai fini di un successivo invio reale. */
export function isPresentResult(result: { success: boolean; active: boolean; message: string }): boolean {
  return result.success && result.active && !result.message.includes('disabilitati');
}

@Injectable()
@Processor(APP_IO_VERIFY_BULK_QUEUE)
export class AppIoVerifyBulkProcessor extends WorkerHost {
  private readonly logger = new Logger(AppIoVerifyBulkProcessor.name);

  constructor(
    @InjectRepository(AppIoVerificationJob)
    private readonly jobRepo: Repository<AppIoVerificationJob>,
    private readonly ioServices: IoServicesService,
  ) {
    super();
  }

  async process(job: Job<AppIoVerifyBulkJobData>): Promise<void> {
    const { jobId } = job.data;
    const record = await this.jobRepo.findOneBy({ id: jobId });
    if (!record) {
      this.logger.warn(`AppIoVerificationJob ${jobId} non trovato — job BullMQ scartato`);
      return;
    }

    await this.jobRepo.update(jobId, { status: AppIoVerificationJobStatus.PROCESSING });

    try {
      const parsed = parseCsvContent(record.sourceCsv, record.hasHeaders);
      const presentRows: Record<string, string>[] = [];
      const absentRows: Record<string, string>[] = [];
      let processed = 0;

      const runRow = async (row: Record<string, string>) => {
        const cf = (row[record.cfColumn] || '').trim().toUpperCase();
        let present = false;
        if (cf.length === 16) {
          try {
            const result = await this.ioServices.verifyProfile(cf, record.ioServiceId);
            present = isPresentResult(result);
          } catch {
            // Errore non gestito da verifyProfile (es. servizio eliminato a
            // metà job): stesso trattamento degli errori di rete, la riga
            // finisce tra gli assenti, il job intero non fallisce per questo.
            present = false;
          }
        }
        (present ? presentRows : absentRows).push(row);
        processed += 1;
        if (processed % PROGRESS_UPDATE_EVERY === 0) {
          await this.jobRepo.update(jobId, { processedRows: processed });
        }
      };

      for (let i = 0; i < parsed.rows.length; i += CONCURRENCY) {
        const batch = parsed.rows.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(runRow));
      }

      await this.jobRepo.update(jobId, {
        status: AppIoVerificationJobStatus.DONE,
        processedRows: parsed.rows.length,
        presentCount: presentRows.length,
        absentCount: absentRows.length,
        resultPresentCsv: buildCsvContent(parsed.headers, presentRows),
        resultAbsentCsv: buildCsvContent(parsed.headers, absentRows),
        completedAt: new Date(),
      });
      this.logger.log(`AppIoVerificationJob ${jobId} completato: ${presentRows.length} presenti, ${absentRows.length} assenti`);
    } catch (err: any) {
      this.logger.error(`AppIoVerificationJob ${jobId} fallito: ${err.message}`);
      await this.jobRepo.update(jobId, {
        status: AppIoVerificationJobStatus.FAILED,
        errorMessage: err.message,
        completedAt: new Date(),
      });
    }
  }
}
