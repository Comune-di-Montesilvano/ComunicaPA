import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { EnrichmentJob, EnrichmentJobStatus } from '../entities/enrichment-job.entity';
import { ENRICHMENT_QUEUE, EnrichmentQueueJobData } from './enrichment-job.types';
import { readCheckpointSync } from './enrichment-checkpoint.util';

/**
 * Un job lasciato in PROCESSING da un riavvio backend non ha altrimenti
 * alcun modo di uscire da quello stato (nessun demone lo tocca, BullMQ non
 * ha retry configurato) — questo scan gira una sola volta a boot.
 *
 * **Due scenari BullMQ diversi dietro lo stesso stato DB "PROCESSING", vanno
 * gestiti in modo opposto** (bug reale trovato in due giri di verifica live
 * separati — il primo giro ha corretto solo metà del problema):
 *
 * 1. Il vecchio job BullMQ con id=job.id è **terminale** (completed/failed) —
 *    es. il worker ha finito di scrivere lo stato DB=PROCESSING iniziale ma
 *    NON è mai arrivato allo stato finale per un crash immediatamente dopo,
 *    oppure (caso verificato dal vivo) il job era già stato processato una
 *    volta e lo stato DB non riflette più la realtà. Qui `queue.add()` con
 *    lo STESSO jobId è un no-op silenzioso — va rimosso esplicitamente prima
 *    di riaggiungerlo, altrimenti il job non riparte mai (nessuna eccezione,
 *    nessun log, il record resta bloccato in PROCESSING per sempre
 *    nonostante il log "riprendo da riga N").
 * 2. Il vecchio job BullMQ è ancora **active** (worker crashato mentre lo
 *    stava eseguendo, lock non rilasciato) — qui NON bisogna toccarlo:
 *    `main.ts` non chiama `app.enableShutdownHooks()` e la coda usa le
 *    opzioni default di BullMQ (`stalledInterval`/`maxStalledCount`), quindi
 *    il meccanismo di stalled-job recovery di BullMQ stesso lo rimette in
 *    coda e lo rielabora DA SOLO entro pochi secondi dal boot del nuovo
 *    worker. Se anche noi aggiungessimo qui un job (con lo stesso id o uno
 *    nuovo), otterremmo DUE `EnrichmentProcessor.process()` concorrenti sullo
 *    stesso `jobId` applicativo — stesso checkpoint letto/scritto due volte,
 *    stessa `result.csv` sovrascritta due volte non atomicamente (rischio
 *    concreto di file troncato/misto). Il fix precedente (rimuovere sempre
 *    `opts.jobId`) copriva SOLO il caso 1, verificato dal vivo forzando a
 *    mano `status='processing'` su un job BullMQ già completato — che non è
 *    la forma di un crash vero, dove il job resta `active`. Corretto:
 *    interrogare lo stato del job BullMQ esistente e agire di conseguenza.
 */
@Injectable()
export class EnrichmentResumeService implements OnModuleInit {
  private readonly logger = new Logger(EnrichmentResumeService.name);

  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    @InjectQueue(ENRICHMENT_QUEUE)
    private readonly queue: Queue<EnrichmentQueueJobData>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.resumeStuckJobs();
  }

  async resumeStuckJobs(): Promise<void> {
    const stuck = await this.jobRepo.find({ where: { status: EnrichmentJobStatus.PROCESSING } });
    for (const job of stuck) {
      const checkpoint = readCheckpointSync(job.id);
      if (checkpoint) {
        const existing = await this.queue.getJob(job.id);
        const state = existing ? await existing.getState() : null;

        if (state === 'active' || state === 'waiting' || state === 'waiting-children' || state === 'delayed') {
          // Il job BullMQ esiste ancora ed è vivo/in attesa — non è davvero
          // "bloccato", è solo il nostro stato DB (aggiornato solo a fine job)
          // a non riflettere ancora la realtà, oppure è genuinamente `active`
          // con lock scaduto: in quel caso lo stalled-job recovery di BullMQ
          // (opzioni default, nessun enableShutdownHooks in main.ts) lo
          // riprende da solo entro pochi secondi. Aggiungerne un secondo qui
          // produrrebbe due process() concorrenti sullo stesso jobId — mai
          // farlo, si limita a loggare.
          this.logger.warn(`EnrichmentJob ${job.id}: job BullMQ ancora presente (stato ${state}) — nessuna azione, lo riprende in carico BullMQ stesso (stalled-job recovery)`);
          continue;
        }

        this.logger.warn(`EnrichmentJob ${job.id} bloccato in PROCESSING dopo riavvio — riprendo da riga ${checkpoint.lastRow}`);
        // Il vecchio job BullMQ (se presente) è in stato terminale
        // (completed/failed) — riaggiungerlo con lo stesso jobId sarebbe un
        // no-op silenzioso di BullMQ (dedup su jobId esistente, qualunque sia
        // lo stato). Va rimosso esplicitamente prima del re-add, altrimenti
        // il job non riparte mai (nessuna eccezione, nessun log, il record
        // resta bloccato in PROCESSING per sempre nonostante il log
        // "riprendo da riga N" — bug reale, verificato dal vivo).
        if (existing) await existing.remove();
        await this.queue.add('enrich', { jobId: job.id }, { jobId: job.id });
      } else {
        this.logger.error(`EnrichmentJob ${job.id} bloccato in PROCESSING dopo riavvio, nessun checkpoint disponibile — marcato FAILED`);
        await this.jobRepo.update(job.id, {
          status: EnrichmentJobStatus.FAILED,
          errorMessage: 'Interrotto da riavvio, nessun checkpoint disponibile',
          completedAt: new Date(),
        });
      }
    }
  }
}
