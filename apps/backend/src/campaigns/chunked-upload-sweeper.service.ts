import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CHUNK_ROOT, CHUNK_SESSION_MAX_AGE_MS, sweepStaleChunkedUploads } from './chunked-upload.util.js';
import {
  sweepStaleUploadBatches,
  UPLOAD_BATCH_MAX_AGE_MS,
  UPLOAD_BATCH_ROOT,
} from '../enrichment/enrichment-batch-upload.util.js';

export interface UploadSweepRoots {
  chunkRoot: string;
  batchRoot: string;
}

const DEFAULT_ROOTS: UploadSweepRoots = { chunkRoot: CHUNK_ROOT, batchRoot: UPLOAD_BATCH_ROOT };

/**
 * Pulizia oraria (un solo cron) delle sessioni di upload a chunk e dei lotti
 * di upload dell'arricchimento più vecchi di 24 h (abbandonati dal browser,
 * rifiutati prima del complete, residui di un riavvio): stanno sul volume
 * persistente del backend e contengono i file caricati dagli operatori. Le
 * route di complete puliscono già la propria sessione/il proprio lotto;
 * questo copre tutto ciò che non arriva al complete. I lotti già completati
 * (pezzi in attesa del job di merge) non vengono toccati.
 */
@Injectable()
export class ChunkedUploadSweeperService {
  private readonly logger = new Logger(ChunkedUploadSweeperService.name);

  @Cron(CronExpression.EVERY_HOUR)
  handleCron(): void {
    this.run();
  }

  /**
   * Mai un throw (gira da cron): errori del filesystem solo a warn, e un
   * errore su una radice non ferma l'altra. Solo i conteggi nei log, mai nomi
   * di file.
   */
  run(now: number = Date.now(), roots: UploadSweepRoots = DEFAULT_ROOTS): { chunkSessions: number; uploadBatches: number } {
    const chunkSessions = this.sweep(
      () => sweepStaleChunkedUploads(roots.chunkRoot, CHUNK_SESSION_MAX_AGE_MS, now),
      'sessioni di upload a chunk',
    );
    const uploadBatches = this.sweep(
      () => sweepStaleUploadBatches(roots.batchRoot, UPLOAD_BATCH_MAX_AGE_MS, now),
      'lotti di upload arricchimento',
    );
    return { chunkSessions, uploadBatches };
  }

  private sweep(fn: () => number, label: string): number {
    try {
      const removed = fn();
      if (removed > 0) this.logger.log(`Pulizia ${label}: ${removed} rimozioni per scadenza`);
      return removed;
    } catch (err) {
      this.logger.warn(`Pulizia ${label} non riuscita: ${(err as NodeJS.ErrnoException).code ?? 'errore'}`);
      return 0;
    }
  }
}
