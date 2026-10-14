import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { In, Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import { RemoteSignJob, RemoteSignJobStatus } from '../entities/remote-sign-job.entity.js';
import { REMOTE_SIGN_QUEUE, RemoteSignQueueJobData } from './remote-sign-job.types.js';

/**
 * A boot chiude i job di firma rimasti queued/processing (riavvio durante la
 * firma): la sessione OTP non è affidabile e un re-run BullMQ rifirmerebbe file
 * già firmati (signatureCheck è obsoleto). L'operatore rilancia con un nuovo OTP.
 * Senza questo la riga resterebbe attiva per sempre, bloccando lancio e upload.
 */
@Injectable()
export class RemoteSignReconcileService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RemoteSignReconcileService.name);

  constructor(
    @InjectRepository(RemoteSignJob) private readonly jobRepo: Repository<RemoteSignJob>,
    @InjectQueue(REMOTE_SIGN_QUEUE) private readonly queue: Queue<RemoteSignQueueJobData>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const rows = await this.jobRepo.find({
      where: { status: In([RemoteSignJobStatus.QUEUED, RemoteSignJobStatus.PROCESSING]) },
    });
    for (const row of rows) {
      try {
        const bull = await this.queue.getJob(row.id);
        if (bull) await bull.remove();
      } catch (err) {
        // Un job active con lock può rifiutare la rimozione: si ignora.
        this.logger.warn(`Firma remota ${row.id}: rimozione job BullMQ non riuscita (${(err as Error).message})`);
      }
      await this.jobRepo.update({ id: row.id }, {
        status: RemoteSignJobStatus.FAILED,
        errorKind: 'session',
        errorMessage: 'Firma interrotta da un riavvio del server: rilancia con un nuovo OTP',
        completedAt: new Date(),
      });
      this.logger.warn(`Firma remota ${row.id} interrotta da riavvio: marcata FAILED`);
    }
  }
}
