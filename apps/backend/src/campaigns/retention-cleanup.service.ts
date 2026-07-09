import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { join } from 'path';
import { unlink, rm, readdir } from 'fs/promises';
import { Recipient } from '../entities/recipient.entity';
import { Campaign } from '../entities/campaign.entity';
import { resolveAttachmentsConfig, resolveCustomAttachmentFilename } from '../attachments/attachment.service';
import { getUploadsDir, getAttachmentsRoot } from '../attachments/attachment-paths';

const BATCH_SIZE = 200;

@Injectable()
export class RetentionCleanupService {
  private readonly logger = new Logger(RetentionCleanupService.name);

  constructor(
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
  ) {}

  @Cron('0 3 * * *')
  async handleCron(): Promise<void> {
    await this.runCleanup();
    await this.runOrphanCleanup();
  }

  /**
   * Cartelle allegati (`uploads/<campaignId>`) rimaste senza una riga
   * `Campaign` corrispondente in DB (es. delete interrotta a metà, tampering
   * manuale del DB) restano a occupare spazio indefinitamente: `remove()`
   * cancella la cartella nella stessa richiesta che elimina la campagna, ma
   * se quella richiesta fallisce dopo il delete DB e prima della `rm`, la
   * cartella diventa orfana e nessun altro codice la ripulisce.
   */
  async runOrphanCleanup(): Promise<void> {
    const uploadsRoot = join(getAttachmentsRoot(), 'uploads');
    let entries: string[];
    try {
      entries = await readdir(uploadsRoot);
    } catch (err) {
      return; // uploads/ non ancora creata: niente da pulire
    }

    let removed = 0;
    for (const campaignId of entries) {
      const exists = await this.campaignRepo.existsBy({ id: campaignId });
      if (exists) continue;
      try {
        await rm(getUploadsDir(campaignId), { recursive: true, force: true });
        removed++;
      } catch (err) {
        this.logger.warn(`Cartella allegati orfana non eliminabile: ${campaignId}`);
      }
    }
    if (removed > 0) {
      this.logger.log(`Retention cleanup: ${removed} cartelle allegati orfane eliminate`);
    }
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
        const attachmentsConfig = resolveAttachmentsConfig(recipient.campaign.channelConfig);
        const totalSlots = Math.max(attachmentsConfig.length, 1); // almeno un tentativo per il fallback legacy

        for (let index = 0; index < totalSlots; index++) {
          const customFilename = resolveCustomAttachmentFilename(recipient, index);
          if (customFilename) {
            const filePath = join(getUploadsDir(recipient.campaignId), customFilename);
            try {
              await unlink(filePath);
            } catch (err) {
              this.logger.warn(`File già assente o non eliminabile: ${filePath}`);
            }
          }
        }

        await this.recipientRepo.update(recipient.id, { attachmentDeletedAt: new Date() });
      }

      totalProcessed += batch.length;
    }

    this.logger.log(`Retention cleanup: ${totalProcessed} allegati da eliminare`);
  }
}
