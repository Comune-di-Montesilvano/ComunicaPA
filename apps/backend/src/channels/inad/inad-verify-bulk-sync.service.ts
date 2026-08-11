import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { InadVerificationJob, InadVerificationJobStatus } from '../../entities/inad-verification-job.entity';
import { parseCsvContent, buildCsvContent } from '../../io-services/csv.util';
import { InadService } from './inad.service';

const ADDRESS_COLUMN = 'domicilio_digitale_inad';

/**
 * Poll periodico dei batch bulk INAD per i job di "Verifica INAD massiva" —
 * stesso pattern demone Cron di InadCheckSyncService (nessuna coda BullMQ,
 * solo Cron + repo diretti), ma su InadVerificationJob invece che su Campaign.
 *
 * Un job resta PROCESSING finché ENTRAMBE le fonti non sono complete: i
 * batch INAD (CF persona fisica) e la quota Partita IVA accodata su
 * registro-imprese-verify (vedi InadVerifyBulkService, RegistroImpreseVerifyProcessor
 * — quest'ultimo scrive piva_done/piva_results in autonomia, questo demone
 * si limita a leggerli). Le PEC trovate via Registro Imprese confluiscono
 * nella stessa colonna ADDRESS_COLUMN dei CF trovati via INAD — un solo CSV
 * risultato indipendente dalla fonte.
 */
@Injectable()
export class InadVerifyBulkSyncService {
  private readonly logger = new Logger(InadVerifyBulkSyncService.name);

  constructor(
    @InjectRepository(InadVerificationJob)
    private readonly jobRepo: Repository<InadVerificationJob>,
    private readonly inadService: InadService,
  ) {}

  @Cron('*/5 * * * *')
  async handleCron(): Promise<void> {
    const jobs = await this.jobRepo.find({ where: { status: InadVerificationJobStatus.PROCESSING } });

    for (const job of jobs) {
      try {
        let allReady = true;
        const batches = job.batches;
        for (const batch of batches) {
          if (batch.done) continue;
          const state = await this.inadService.getBulkState(batch.id);
          if (state === 'DISPONIBILE') {
            batch.done = true;
          } else {
            allReady = false;
          }
        }

        const pivaReady = job.pivaTotal === 0 || job.pivaDone >= job.pivaTotal;
        if (!allReady || !pivaReady) {
          await this.jobRepo.update(job.id, { batches });
          continue;
        }

        const foundAddresses = new Map<string, string>();
        for (const batch of batches) {
          const items = await this.inadService.getBulkResult(batch.id);
          items.forEach((item) => {
            const addresses = (item.digitalAddress ?? []).map((a) => a.digitalAddress).join('; ');
            foundAddresses.set(item.codiceFiscale.toUpperCase(), addresses);
          });
        }
        for (const [piva, pec] of Object.entries(job.pivaResults ?? {})) {
          if (pec) foundAddresses.set(piva, pec);
        }

        const parsed = parseCsvContent(job.sourceCsv, job.hasHeaders);
        const foundHeaders = [...parsed.headers, ADDRESS_COLUMN];
        const foundRows: Record<string, string>[] = [];
        const notFoundRows: Record<string, string>[] = [];
        for (const row of parsed.rows) {
          const cf = (row[job.cfColumn] || '').trim().toUpperCase();
          const address = foundAddresses.get(cf);
          if (address !== undefined) {
            foundRows.push({ ...row, [ADDRESS_COLUMN]: address });
          } else {
            notFoundRows.push(row);
          }
        }

        await this.jobRepo.update(job.id, {
          status: InadVerificationJobStatus.DONE,
          batches,
          foundCount: foundRows.length,
          notFoundCount: notFoundRows.length,
          resultFoundCsv: buildCsvContent(foundHeaders, foundRows),
          resultNotFoundCsv: buildCsvContent(parsed.headers, notFoundRows),
          completedAt: new Date(),
        });
        this.logger.log(`InadVerificationJob ${job.id} completato: ${foundRows.length} trovati, ${notFoundRows.length} non trovati`);
      } catch (err) {
        this.logger.warn(`Errore sync job verifica INAD ${job.id}: ${err instanceof Error ? err.message : err}`);
        await this.jobRepo.update(job.id, {
          status: InadVerificationJobStatus.FAILED,
          errorMessage: err instanceof Error ? err.message : 'Errore sconosciuto',
          completedAt: new Date(),
        });
      }
    }
  }
}
