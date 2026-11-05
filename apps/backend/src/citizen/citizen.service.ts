import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { Recipient } from '../entities/recipient.entity.js';
import { CampaignStatus } from '../entities/campaign.entity.js';
import { DownloadEvent } from '../entities/download-event.entity.js';
import { AttachmentService, resolveAttachmentsConfig, resolveAttachmentLabel, resolveCustomAttachmentFilename } from '../attachments/attachment.service.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { sendDocumentsAvailableUntil, sendLegalDateOf } from '../campaigns/send-legal-date.util.js';

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
  /** SEND: data con valore legale (perfezionamento), null se non ancora raggiunta. */
  sendLegalDate?: string | null;
  /** SEND: fine dei 120 giorni di consultazione su SEND (null se non ancora con valore legale). */
  sendDocumentsAvailableUntil?: string | null;
  /** SEND: 120 giorni scaduti, il portale offre la copia locale senza valore legale. */
  sendCopyAvailable?: boolean;
}

/**
 * Copia locale degli allegati di una notifica SEND: solo dopo i 120 giorni in
 * cui SEND li mostra, mai prima (lì hanno valore legale, qui no).
 */
function isSendCopyAvailable(recipient: Recipient, now = new Date()): boolean {
  if (recipient.campaign.channelType !== 'SEND') return false;
  const sendAttempt = recipient.attempts?.find(a => a.channelType === 'SEND' && a.status === 'success');
  const until = sendDocumentsAvailableUntil(sendAttempt?.sendStatusHistory);
  return !!until && now.getTime() > until.getTime();
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
    const isSend = recipient.campaign.channelType === 'SEND';
    const sendAvailableUntil = isSend ? sendDocumentsAvailableUntil(sendAttempt?.sendStatusHistory) : null;
    const sendCopyAvailable = isSendCopyAvailable(recipient);
    // Notifica SEND: nessun documento dal portale finché SEND li mostra (unico
    // luogo dove hanno valore legale), poi la copia locale — vedi generateAttachmentPdf.
    if (isSend && !sendCopyAvailable) attachments = [];
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
      ...(isSend ? { sendLegalDate: sendLegalDateOf(sendAttempt?.sendStatusHistory), sendDocumentsAvailableUntil: sendAvailableUntil?.toISOString() ?? null, sendCopyAvailable } : {}),
    };
  }

  async findAllForCitizen(codiceFiscale: string): Promise<CitizenNotificationDto[]> {
    // Le bozze (campaign.status=DRAFT) hanno già Recipient in DB — sync
    // anticipato del wizard ad ogni "avanti" (vedi CLAUDE.md) — ma non sono
    // mai state lanciate: un cittadino non deve vederle prima dell'invio
    // reale (bug reale: contenuto ancora in modifica, mai confermato
    // dall'operatore, visibile in anteprima sul portale cittadino).
    const recipients = await this.recipientRepo.find({
      where: { codiceFiscale: codiceFiscale.toUpperCase().trim(), campaign: { status: Not(CampaignStatus.DRAFT) } },
      relations: { campaign: true, attempts: true },
      order: { createdAt: 'DESC' },
    });
    return Promise.all(recipients.map((r) => this.toCitizenDto(r)));
  }

  private async findRecipientEntity(id: string, codiceFiscale: string): Promise<Recipient> {
    const recipient = await this.recipientRepo.findOne({
      where: {
        id,
        codiceFiscale: codiceFiscale.toUpperCase().trim(),
        campaign: { status: Not(CampaignStatus.DRAFT) },
      },
      relations: { campaign: true, attempts: true },
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
    if (recipient.campaign.channelType === 'SEND' && !isSendCopyAvailable(recipient)) {
      throw new NotFoundException('Per le notifiche SEND i documenti sono disponibili su notifichedigitali.it per 120 giorni dalla data legale');
    }
    return this.attachmentService.generatePdfBuffer(recipient, attachmentIndex);
  }
}
