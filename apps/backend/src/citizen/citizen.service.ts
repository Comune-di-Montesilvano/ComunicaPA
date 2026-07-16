import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Recipient } from '../entities/recipient.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { AttachmentService, resolveAttachmentsConfig, resolveAttachmentLabel, resolveCustomAttachmentFilename } from '../attachments/attachment.service';
import { CampaignsService } from '../campaigns/campaigns.service';

export interface CitizenAttachmentDto {
  index: number;
  label: string;
}

export interface CitizenNotificationDto {
  id: string;
  codiceFiscale: string;
  fullName: string | null;
  email: string | null;
  pec: string | null;
  status: Recipient['status'];
  createdAt: Date;
  extraData?: Record<string, unknown>;
  channelType: string;
  subject: string;
  bodyHtml?: string;
  bodyMarkdown?: string;
  attachments: CitizenAttachmentDto[];
  iun?: string | null;
  sendStatus?: string | null;
  sendStatusHistory?: any[] | null;
  sendDigitalDomicile?: any | null;
}

@Injectable()
export class CitizenService {
  private readonly logger = new Logger(CitizenService.name);

  constructor(
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(DownloadEvent)
    private readonly downloadEventRepo: Repository<DownloadEvent>,
    private readonly attachmentService: AttachmentService,
    private readonly campaignsService: CampaignsService,
  ) {}

  private async toCitizenDto(recipient: Recipient): Promise<CitizenNotificationDto> {
    // preview=false: questo è il link REALE mostrato al cittadino nel suo portale,
    // non un'anteprima backoffice — il click deve continuare a contare come download.
    const preview = await this.campaignsService.renderMessageForRecipient(recipient.id, 'CITIZEN_PORTAL', false);
    let attachments = resolveAttachmentsConfig(recipient.campaign.channelConfig).map((a, index) => ({ index, label: resolveAttachmentLabel(a, recipient) }));
    if (attachments.length === 0) {
      const legacyFile = resolveCustomAttachmentFilename(recipient, 0);
      if (legacyFile) {
        attachments = [{ index: 0, label: 'Documento principale.pdf' }];
      }
    }
    const sendAttempt = recipient.attempts?.find(a => a.channelType === 'SEND' && a.status === 'success');
    return {
      id: recipient.id,
      codiceFiscale: recipient.codiceFiscale,
      fullName: recipient.fullName,
      email: recipient.email,
      pec: recipient.pec,
      status: recipient.status,
      createdAt: recipient.createdAt,
      extraData: recipient.extraData,
      channelType: recipient.campaign.channelType,
      subject: preview.subject,
      bodyHtml: preview.bodyHtml,
      bodyMarkdown: preview.bodyMarkdown,
      attachments,
      iun: sendAttempt?.iun || null,
      sendStatus: sendAttempt?.sendStatus || null,
      sendStatusHistory: sendAttempt?.sendStatusHistory || null,
      sendDigitalDomicile: sendAttempt?.sendDigitalDomicile || null,
    };
  }

  async findAllForCitizen(codiceFiscale: string): Promise<CitizenNotificationDto[]> {
    const recipients = await this.recipientRepo.find({
      where: { codiceFiscale: codiceFiscale.toUpperCase().trim() },
      relations: ['campaign', 'attempts'],
      order: { createdAt: 'DESC' },
    });
    return Promise.all(recipients.map((r) => this.toCitizenDto(r)));
  }

  private async findRecipientEntity(id: string, codiceFiscale: string): Promise<Recipient> {
    const recipient = await this.recipientRepo.findOne({
      where: {
        id,
        codiceFiscale: codiceFiscale.toUpperCase().trim(),
      },
      relations: ['campaign', 'attempts'],
    });

    if (!recipient) {
      throw new NotFoundException(`Notifica ${id} non trovata`);
    }

    return recipient;
  }

  async findOneForCitizen(id: string, codiceFiscale: string): Promise<CitizenNotificationDto> {
    const recipient = await this.findRecipientEntity(id, codiceFiscale);
    return this.toCitizenDto(recipient);
  }

  async markAsDownloaded(id: string, codiceFiscale: string, attachmentIndex = 0): Promise<Recipient> {
    const recipient = await this.findRecipientEntity(id, codiceFiscale);

    if (!recipient.extraData) {
      recipient.extraData = {};
    }

    const currentCount = Number(recipient.extraData['download_count'] ?? 0);
    recipient.extraData['download_count'] = currentCount + 1;
    recipient.extraData['downloaded_at'] = new Date().toISOString();

    await this.recipientRepo.save(recipient);
    try {
      await this.downloadEventRepo.insert({ recipientId: id, channel: 'CITIZEN_PORTAL', attachmentIndex });
    } catch (err: any) {
      this.logger.warn(`Impossibile registrare DownloadEvent per recipient ${id}: ${err?.message ?? err}`);
    }
    return recipient;
  }

  async generateAttachmentPdf(id: string, codiceFiscale: string, attachmentIndex = 0): Promise<Buffer> {
    const recipient = await this.findRecipientEntity(id, codiceFiscale);
    return this.attachmentService.generatePdfBuffer(recipient, attachmentIndex);
  }
}
