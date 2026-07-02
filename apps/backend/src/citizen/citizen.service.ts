import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Recipient } from '../entities/recipient.entity';
import { AttachmentService } from '../attachments/attachment.service';

@Injectable()
export class CitizenService {
  constructor(
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    private readonly attachmentService: AttachmentService,
  ) {}

  async findAllForCitizen(codiceFiscale: string): Promise<Recipient[]> {
    return this.recipientRepo.find({
      where: { codiceFiscale: codiceFiscale.toUpperCase().trim() },
      relations: ['campaign', 'attempts'],
      order: { createdAt: 'DESC' },
    });
  }

  async findOneForCitizen(id: string, codiceFiscale: string): Promise<Recipient> {
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

  async markAsDownloaded(id: string, codiceFiscale: string): Promise<Recipient> {
    const recipient = await this.findOneForCitizen(id, codiceFiscale);

    if (!recipient.extraData) {
      recipient.extraData = {};
    }

    const currentCount = Number(recipient.extraData['download_count'] ?? 0);
    recipient.extraData['download_count'] = currentCount + 1;
    recipient.extraData['downloaded_at'] = new Date().toISOString();

    await this.recipientRepo.save(recipient);
    return recipient;
  }

  async generateAttachmentPdf(id: string, codiceFiscale: string): Promise<Buffer> {
    const recipient = await this.findOneForCitizen(id, codiceFiscale);
    return this.attachmentService.generatePdfBuffer(recipient);
  }
}
