import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { join } from 'path';
import { unlink } from 'fs/promises';
import { Recipient } from '../entities/recipient.entity';
import { resolveCustomAttachmentFilename } from '../attachments/attachment.service';
import { getUploadsDir } from '../attachments/attachment-paths';

const BATCH_SIZE = 200;

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
    let totalProcessed = 0;

    // Elaboriamo i destinatari scaduti a lotti (BATCH_SIZE alla volta) invece di
    // caricarli tutti in memoria con un unico getMany(): le campagne possono avere
    // migliaia di destinatari e molti potrebbero scadere la stessa notte.
    // Ogni riga già processata ottiene attachment_deleted_at valorizzato, quindi
    // esce automaticamente dalla WHERE alla riesecuzione della query: non serve
    // .skip(), basta continuare a interrogare finché un lotto non torna vuoto.
    for (;;) {
      const batch = await this.recipientRepo
        .createQueryBuilder('recipient')
        .leftJoinAndSelect('recipient.campaign', 'campaign')
        .where('recipient.attachment_expires_at < :now', { now: new Date() })
        .andWhere('recipient.attachment_deleted_at IS NULL')
        .take(BATCH_SIZE)
        .getMany();

      if (batch.length === 0) {
        break;
      }

      for (const recipient of batch) {
        const customFilename = resolveCustomAttachmentFilename(recipient);

        if (customFilename) {
          const filePath = join(getUploadsDir(recipient.campaignId), customFilename);
          try {
            await unlink(filePath);
          } catch (err) {
            this.logger.warn(`File già assente o non eliminabile: ${filePath}`);
          }
        }

        await this.recipientRepo.update(recipient.id, { attachmentDeletedAt: new Date() });
      }

      totalProcessed += batch.length;
    }

    this.logger.log(`Retention cleanup: ${totalProcessed} allegati da eliminare`);
  }
}
