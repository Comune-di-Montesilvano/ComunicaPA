import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as fs from 'fs';
import { In, Repository } from 'typeorm';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { getUploadsDir } from '../attachments/attachment-paths';

/**
 * Estratto da notification.processor.ts (era privato lì, chiamato solo dal
 * flusso BullMQ) — condiviso anche da SendDispatchService, che dal refactor
 * "pipeline a demoni" non passa più da BullMQ per SEND e quindi non
 * chiamava mai questo check: le campagne SEND restavano QUEUED per sempre
 * anche a invio terminato per tutti i destinatari.
 */
@Injectable()
export class CampaignCompletionService {
  constructor(
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
  ) {}

  /**
   * Se non restano destinatari PENDING/QUEUED per la campagna, la marca
   * COMPLETED. È l'unico punto che porta una campagna fuori da QUEUED, che
   * altrimenti resterebbe tale per sempre anche a invio terminato.
   */
  async checkAndComplete(campaignId: string): Promise<void> {
    const remaining = await this.recipientRepo.count({
      where: { campaignId, status: In([RecipientStatus.PENDING, RecipientStatus.QUEUED]) },
    });
    if (remaining > 0) return;

    const result = await this.campaignRepo
      .createQueryBuilder()
      .update()
      .set({ status: CampaignStatus.COMPLETED, completedAt: new Date() })
      .where('id = :id AND status = :queued', { id: campaignId, queued: CampaignStatus.QUEUED })
      .execute();

    if (result.affected && result.affected > 0) {
      await this.deleteLinkedTestCampaign(campaignId);
    }
  }

  /**
   * Cascata esplicita (non FK ON DELETE, la madre non viene cancellata qui):
   * elimina NotificationAttempt+Recipient+Campaign della campagna test
   * collegata e la sua cartella allegati su disco. Best-effort sui job
   * BullMQ ancora pendenti: non tentato qui, vedi nota nel piano di
   * implementazione (rischio di dipendenza circolare tra moduli).
   */
  private async deleteLinkedTestCampaign(parentCampaignId: string): Promise<void> {
    const child = await this.campaignRepo.findOneBy({ parentCampaignId, isTest: true });
    if (!child) return;

    const recipients = await this.recipientRepo.find({ where: { campaignId: child.id }, select: ['id'] });
    const recipientIds = recipients.map((r) => r.id);
    if (recipientIds.length > 0) {
      await this.attemptRepo.delete({ recipientId: In(recipientIds) });
      await this.recipientRepo.delete({ id: In(recipientIds) });
    }
    await this.campaignRepo.delete(child.id);

    try {
      fs.rmSync(getUploadsDir(child.id), { recursive: true, force: true });
    } catch {
      // best-effort: cartella già assente non è un errore
    }
  }
}
