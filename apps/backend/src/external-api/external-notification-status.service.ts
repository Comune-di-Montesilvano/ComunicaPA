import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { Recipient } from '../entities/recipient.entity.js';
import { Campaign } from '../entities/campaign.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { PostalPosteTracking } from '../entities/postal-poste-tracking.entity.js';
import { ExternalApiError } from './external-api.error.js';
import { buildNotificationStatus, type NotificationStatusResponse } from './external-notification-status.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ExternalNotificationStatusService {
  constructor(
    @InjectRepository(Recipient) private readonly recipients: Repository<Recipient>,
    @InjectRepository(Campaign) private readonly campaigns: Repository<Campaign>,
    @InjectRepository(NotificationAttempt) private readonly attempts: Repository<NotificationAttempt>,
    @InjectRepository(PostalPosteTracking) private readonly poste: Repository<PostalPosteTracking>,
  ) {}

  async get(notificationId: string, clientId: string): Promise<NotificationStatusResponse> {
    // Stesso errore per id malformato, inesistente o di un altro client: nessuna enumerazione.
    const notFound = new ExternalApiError('NOT_FOUND', 'Notifica non trovata');
    if (!UUID.test(notificationId)) throw notFound;
    const recipient = await this.recipients.findOne({ where: { id: notificationId } });
    if (!recipient) throw notFound;
    const campaign = await this.campaigns.findOneBy({ id: recipient.campaignId });
    if (!campaign || campaign.externalClientId !== clientId) throw notFound;

    const attempts = await this.attempts.find({ where: { recipientId: recipient.id } });
    const latest = attempts.reduce<NotificationAttempt | null>((a, b) => (!a || b.attemptNumber > a.attemptNumber ? b : a), null);
    const poste = latest ? await this.poste.findOne({ where: { attemptId: latest.id } }) : null;

    return buildNotificationStatus({
      recipient: { id: recipient.id, createdAt: recipient.createdAt, status: recipient.status, codiceFiscale: recipient.codiceFiscale, inadCheck: recipient.inadCheck },
      campaign: { status: campaign.status, channelType: campaign.channelType, channelConfig: campaign.channelConfig ?? {} },
      attempt: latest,
      poste: poste ? { status: poste.status, outcomeAt: poste.outcomeAt } : null,
    });
  }
}
