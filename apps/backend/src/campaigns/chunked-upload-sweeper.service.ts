import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CHUNK_ROOT, CHUNK_SESSION_MAX_AGE_MS, sweepStaleChunkedUploads } from './chunked-upload.util.js';

/**
 * Pulizia oraria delle sessioni di upload a chunk più vecchie di 24 h
 * (abbandonate dal browser, rifiutate prima del complete, residui di un
 * riavvio): `CHUNK_ROOT` sta sul volume persistente del backend e i chunk
 * contengono i file caricati dagli operatori. Le route di complete puliscono
 * già la propria sessione; questo copre tutto ciò che non arriva al complete.
 */
@Injectable()
export class ChunkedUploadSweeperService {
  private readonly logger = new Logger(ChunkedUploadSweeperService.name);

  @Cron(CronExpression.EVERY_HOUR)
  handleCron(): void {
    this.run();
  }

  /** Mai un throw (gira da cron): errori del filesystem solo a warn. Solo il conteggio nei log, mai nomi di file. */
  run(root: string = CHUNK_ROOT, now: number = Date.now()): number {
    try {
      const removed = sweepStaleChunkedUploads(root, CHUNK_SESSION_MAX_AGE_MS, now);
      if (removed > 0) this.logger.log(`Rimosse ${removed} sessioni di upload a chunk scadute`);
      return removed;
    } catch (err) {
      this.logger.warn(`Pulizia sessioni di upload a chunk non riuscita: ${(err as NodeJS.ErrnoException).code ?? 'errore'}`);
      return 0;
    }
  }
}
