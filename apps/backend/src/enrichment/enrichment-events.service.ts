import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

export interface EnrichmentLogEvent {
  type: 'log';
  row: number;
  pdf: string;
  detail: 'full' | 'summary';
  payload: Record<string, unknown>;
}

export interface EnrichmentTerminalEvent {
  type: 'done' | 'error';
  message?: string;
}

export type EnrichmentStreamEvent = EnrichmentLogEvent | EnrichmentTerminalEvent;

/**
 * Bridge in-memory tra il worker BullMQ (EnrichmentProcessor) e l'endpoint
 * SSE consultato dal frontend. Funziona SOLO perché worker e HTTP server
 * girano nello stesso processo Node (un solo servizio "backend" in
 * docker-compose, nessun worker separato) — se in futuro il backend scala a
 * più repliche, va sostituito con Redis pub/sub (non anticipato ora, YAGNI).
 * Nessuna persistenza: chi non è connesso quando un evento viene emesso lo
 * perde, è un log LIVE non uno storico (i warning finali restano comunque
 * su EnrichmentJob.warnings a fine job).
 */
@Injectable()
export class EnrichmentEventsService {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Più operatori potrebbero osservare lo stesso job in parallelo.
    this.emitter.setMaxListeners(50);
  }

  emitLog(jobId: string, event: Omit<EnrichmentLogEvent, 'type'>): void {
    this.emitter.emit(jobId, { type: 'log', ...event } satisfies EnrichmentLogEvent);
  }

  emitTerminal(jobId: string, event: EnrichmentTerminalEvent): void {
    this.emitter.emit(jobId, event);
  }

  subscribe(jobId: string, onEvent: (e: EnrichmentStreamEvent) => void): () => void {
    this.emitter.on(jobId, onEvent);
    return () => this.emitter.off(jobId, onEvent);
  }
}
