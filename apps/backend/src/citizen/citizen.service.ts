import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { Recipient } from '../entities/recipient.entity';

@Injectable()
export class CitizenService {
  constructor(
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
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

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage();
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

    // Header
    page.drawText('COMUNE DI MONTESILVANO', {
      x: 50,
      y: 750,
      size: 16,
      font: fontBold,
      color: rgb(0, 0.2, 0.4),
    });
    page.drawText('ComunicaPA — Hub di Trasmissione Comunicazioni', {
      x: 50,
      y: 730,
      size: 10,
      font: fontRegular,
      color: rgb(0.5, 0.5, 0.5),
    });

    // Divider
    page.drawLine({
      start: { x: 50, y: 715 },
      end: { x: 550, y: 715 },
      thickness: 1,
      color: rgb(0.8, 0.8, 0.8),
    });

    // Recipient Info
    page.drawText(`Destinatario: ${recipient.fullName || 'N/D'}`, { x: 50, y: 680, size: 11, font: fontBold });
    page.drawText(`Codice Fiscale: ${recipient.codiceFiscale}`, { x: 50, y: 660, size: 11, font: fontRegular });
    if (recipient.email) {
      page.drawText(`Email: ${recipient.email}`, { x: 50, y: 645, size: 11, font: fontRegular });
    }
    if (recipient.pec) {
      page.drawText(`PEC: ${recipient.pec}`, { x: 50, y: 630, size: 11, font: fontRegular });
    }

    // Campaign Subject
    page.drawText("Oggetto dell'avviso:", {
      x: 50,
      y: 580,
      size: 11,
      font: fontBold,
      color: rgb(0, 0.2, 0.4),
    });
    page.drawText(recipient.campaign.name, { x: 50, y: 560, size: 12, font: fontBold });

    // Campaign Description/Body
    page.drawText('Dettaglio comunicazione:', { x: 50, y: 520, size: 11, font: fontBold });
    const description = recipient.campaign.description || 'Nessuna descrizione specificata.';
    page.drawText(description, {
      x: 50,
      y: 500,
      size: 11,
      font: fontRegular,
      maxWidth: 500,
      lineHeight: 14,
    });

    // Protocol Stamp (Mocked)
    page.drawText(`PROTOCOLLO GENERALE - N. COM_${recipient.id.slice(0, 8).toUpperCase()}`, {
      x: 310,
      y: 750,
      size: 8,
      font: fontBold,
      color: rgb(0.8, 0.1, 0.1),
    });

    // Footer
    page.drawLine({
      start: { x: 50, y: 150 },
      end: { x: 550, y: 150 },
      thickness: 1,
      color: rgb(0.8, 0.8, 0.8),
    });
    page.drawText(`Identificativo notifica: ${recipient.id}`, {
      x: 50,
      y: 130,
      size: 9,
      font: fontRegular,
      color: rgb(0.5, 0.5, 0.5),
    });
    page.drawText(`Data invio: ${recipient.createdAt.toLocaleDateString('it-IT')}`, {
      x: 50,
      y: 115,
      size: 9,
      font: fontRegular,
      color: rgb(0.5, 0.5, 0.5),
    });
    page.drawText(`Canale di trasmissione: ${recipient.campaign.channelType}`, {
      x: 50,
      y: 100,
      size: 9,
      font: fontRegular,
      color: rgb(0.5, 0.5, 0.5),
    });

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }
}
