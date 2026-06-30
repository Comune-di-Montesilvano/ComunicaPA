import { Injectable } from '@nestjs/common';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';

@Injectable()
export class AppIoStrategy implements IChannelStrategy {
  readonly channel: NotificationChannel = 'APP_IO';
  async send(_recipient: Recipient, _campaign: Campaign): Promise<ChannelSendResult> {
    throw new Error('AppIoStrategy not implemented');
  }
}
