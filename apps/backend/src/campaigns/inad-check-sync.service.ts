import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { InadService } from '../channels/inad/inad.service';
import { RegistroImpreseVerifyQueueService } from '../channels/registro-imprese/registro-imprese-verify-queue.service';
import { CampaignsService } from './campaigns.service';

interface InadCheckBulkState {
  mechanism: 'bulk';
  batches: Array<{ id: string; recipientIds: string[]; done: boolean }>;
  /** Destinatari Partita IVA in verifica su Registro Imprese (coda BullMQ, non batch INAD) — vedi campaigns.service.ts startInadBulkCheck. */
  pivaRecipientIds?: string[];
  requestedAt: string;
}

/**
 * Poll periodico dei batch bulk INAD (/listDigitalAddress) E dei job PIVA
 * (Registro Imprese, coda BullMQ) per le campagne ferme in CHECKING_INAD —
 * stesso pattern "demone" di SendStatusSyncService/PostalStatusSyncService
 * per la parte INAD; la parte PIVA interroga direttamente lo stato dei job
 * BullMQ (nessun demone dedicato separato, stessa coda del check singolo).
 */
@Injectable()
export class InadCheckSyncService {
  private readonly logger = new Logger(InadCheckSyncService.name);

  constructor(
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    private readonly inadService: InadService,
    private readonly registroImpreseVerifyQueue: RegistroImpreseVerifyQueueService,
    private readonly campaignsService: CampaignsService,
  ) {}

  @Cron('*/5 * * * *')
  async handleCron(): Promise<void> {
    const campaigns = await this.campaignRepo.find({ where: { status: CampaignStatus.CHECKING_INAD } });

    for (const campaign of campaigns) {
      const inadCheck = campaign.channelConfig?.['inadCheck'] as InadCheckBulkState | undefined;
      if (!inadCheck || inadCheck.mechanism !== 'bulk') continue;

      const pendingBatches = inadCheck.batches.filter((b) => !b.done);
      const pivaRecipientIds = inadCheck.pivaRecipientIds ?? [];
      if (pendingBatches.length === 0 && pivaRecipientIds.length === 0) continue;

      try {
        let allReady = true;
        for (const batch of pendingBatches) {
          const state = await this.inadService.getBulkState(batch.id);
          if (state !== 'DISPONIBILE') {
            allReady = false;
            break;
          }
        }
        if (allReady) {
          for (const recipientId of pivaRecipientIds) {
            const done = await this.registroImpreseVerifyQueue.isCampaignJobDone(campaign.id, recipientId);
            if (!done) {
              allReady = false;
              break;
            }
          }
        }
        if (allReady) {
          await this.campaignsService.finalizeInadCheck(campaign.id);
        }
      } catch (err) {
        this.logger.warn(`Errore verifica stato INAD/Registro Imprese bulk per campagna ${campaign.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
