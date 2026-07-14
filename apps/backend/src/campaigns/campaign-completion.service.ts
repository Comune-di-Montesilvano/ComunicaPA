import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';

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

    await this.campaignRepo
      .createQueryBuilder()
      .update()
      .set({ status: CampaignStatus.COMPLETED, completedAt: new Date() })
      .where('id = :id AND status = :queued', { id: campaignId, queued: CampaignStatus.QUEUED })
      .execute();
  }
}
