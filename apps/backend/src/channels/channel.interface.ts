import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { Recipient } from '../entities/recipient.entity';
import type { Campaign } from '../entities/campaign.entity';

/** Riceve una riga di log per volta; il chiamante decide dove persisterla (es. job.log() BullMQ). */
export type ChannelLogFn = (message: string) => void;

export interface IChannelStrategy {
  readonly channel: NotificationChannel;
  /**
   * attemptId: id di NotificationAttempt (= BullMQ jobId), opzionale.
   * Usato dalle strategy che espongono un idempotence token verso il provider
   * esterno (es. SEND/PN) per far riconoscere una redelivery dello stesso job
   * come duplicato invece di generare un secondo invio reale.
   * attemptsMade: numero di tentativi BullMQ già fatti per questo job
   * (job.attemptsMade). 0 = primo tentativo. Usato da POSTAL, insieme al
   * numero di tentativo "piggybacked" su recipient (recipient.attemptNumber,
   * impostato dal processor per coprire anche i retry manuali via
   * "Rimetti in coda", che creano un nuovo attemptId/job con attemptsMade=0),
   * per decidere se verificare un eventuale invio già presente su GlobalCom
   * prima di reinviare (nessuna ambiguità al primo tentativo in assoluto).
   */
  send(recipient: Recipient, campaign: Campaign, onLog?: ChannelLogFn, attemptId?: string, attemptsMade?: number): Promise<ChannelSendResult>;
}

export const CHANNEL_STRATEGIES = Symbol('CHANNEL_STRATEGIES');
