import { Injectable } from '@nestjs/common';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';

@Injectable()
export class EmailStrategy implements IChannelStrategy {
  readonly channel: NotificationChannel = 'EMAIL';
  async send(_recipient: Recipient, _campaign: Campaign): Promise<ChannelSendResult> {
    throw new Error('EmailStrategy not implemented');
  }
}
