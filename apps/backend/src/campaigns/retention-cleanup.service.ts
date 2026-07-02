import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { join } from 'path';
import { unlink } from 'fs/promises';
import { Recipient } from '../entities/recipient.entity';

@Injectable()
export class RetentionCleanupService {
  private readonly logger = new Logger(RetentionCleanupService.name);

  constructor(
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
  ) {}

  @Cron('0 3 * * *')
  async handleCron(): Promise<void> {
    await this.runCleanup();
  }

  async runCleanup(): Promise<void> {
    const expired = await this.recipientRepo
      .createQueryBuilder('recipient')
      .leftJoinAndSelect('recipient.campaign', 'campaign')
      .where('recipient.attachment_expires_at < :now', { now: new Date() })
      .andWhere('recipient.attachment_deleted_at IS NULL')
      .getMany();

    this.logger.log(`Retention cleanup: ${expired.length} allegati da eliminare`);

    for (const recipient of expired) {
      const allegatoKey = recipient.campaign?.channelConfig?.['allegatoKey'] as string | undefined;
      const customFilename = allegatoKey ? (recipient.extraData?.[allegatoKey] as string | undefined) : undefined;

      if (customFilename) {
        const filePath = join(__dirname, '..', '..', 'uploads', 'attachments', recipient.campaignId, customFilename);
        try {
          await unlink(filePath);
        } catch (err) {
          this.logger.warn(`File già assente o non eliminabile: ${filePath}`);
        }
      }

      await this.recipientRepo.update(recipient.id, { attachmentDeletedAt: new Date() });
    }
  }
}
