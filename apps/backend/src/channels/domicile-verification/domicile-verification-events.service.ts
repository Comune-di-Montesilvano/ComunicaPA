import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

/**
 * Trigger immediato per DomicileVerificationSyncService quando App IO o
 * Registro Imprese completano — senza questo, il completamento dell'ultima
 * fonte rimasta (tipico: Registro Imprese residuo dopo che INAD è già
 * pronto) resta invisibile fino al prossimo tick cron (fino a 5 minuti di
 * attesa inutile anche se tutte le fonti sono già finite). Il cron
 * (`DomicileVerificationSyncService.handleCron`) resta comunque l'unico
 * modo per scoprire che INAD è passato a DISPONIBILE (nessun evento da
 * INAD, solo poll) — questo evento serve solo per non aspettare un giro di
 * cron di troppo quando è INAD il primo a diventare pronto.
 */
@Injectable()
export class DomicileVerificationEventsService {
  private readonly emitter = new EventEmitter();

  notifyJobProgress(jobId: string): void {
    this.emitter.emit('progress', jobId);
  }

  onJobProgress(listener: (jobId: string) => void): void {
    this.emitter.on('progress', listener);
  }
}
