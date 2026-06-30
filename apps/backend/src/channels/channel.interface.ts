import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { Recipient } from '../entities/recipient.entity';
import type { Campaign } from '../entities/campaign.entity';

export interface IChannelStrategy {
  readonly channel: NotificationChannel;
  send(recipient: Recipient, campaign: Campaign): Promise<ChannelSendResult>;
}

export const CHANNEL_STRATEGIES = Symbol('CHANNEL_STRATEGIES');
