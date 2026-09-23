import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { Campaign, CampaignStatus } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { InadService, InadQuotaExceededError } from '../channels/inad/inad.service.js';
import { RegistroImpreseVerifyQueueService } from '../channels/registro-imprese/registro-imprese-verify-queue.service.js';
import { CampaignsService } from './campaigns.service.js';

interface InadCheckBulkState {
  mechanism: 'bulk';
  /** id: null = batch non ancora sottomesso a INAD (quota giornaliera esaurita al lancio o a un tick precedente) — ri-sottomesso qui ad ogni giro finché non riesce. */
  batches: Array<{ id: string | null; recipientIds: string[]; done: boolean }>;
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
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
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
        // Batch non ancora sottomessi a INAD (quota giornaliera esaurita al
        // lancio o a un tick precedente, campaigns.service.ts startInadBulkCheck)
        // — ritenta la sottomissione qui, prima del poll stato. Se torna a
        // esaurirsi (quota ancora piena), resta id:null e si riprova al
        // prossimo tick: nessun crash, nessun limite di tentativi.
        let mutated = false;
        for (const batch of pendingBatches) {
          if (batch.id) continue;
          try {
            const recs = await this.recipientRepo.find({ where: { id: In(batch.recipientIds) } });
            const cfList = recs.map((r) => r.codiceFiscale).filter((cf): cf is string => !!cf);
            const { id } = await this.inadService.startBulkExtraction(cfList, `comunicapa-campagna-${campaign.id}`);
            batch.id = id;
            mutated = true;
          } catch (err) {
            if (!(err instanceof InadQuotaExceededError)) {
              this.logger.warn(`Ri-sottomissione batch INAD fallita per campagna ${campaign.id}: ${err instanceof Error ? err.message : err}`);
            }
            // Quota ancora esaurita (o altro errore transitorio): resta
            // id:null, riprovato al prossimo tick.
          }
        }
        if (mutated) {
          campaign.channelConfig = { ...campaign.channelConfig, inadCheck };
          await this.campaignRepo.save(campaign);
        }

        let allReady = true;
        for (const batch of pendingBatches) {
          if (!batch.id) {
            allReady = false;
            break;
          }
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
