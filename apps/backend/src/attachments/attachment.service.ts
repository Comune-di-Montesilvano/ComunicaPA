import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as fs from 'fs';
import { join } from 'path';
import type { Recipient } from '../entities/recipient.entity';
import { getUploadsDir } from './attachment-paths';

/**
 * Risolve il nome del file dell'allegato PDF personalizzato per un destinatario.
 *
 * Priorità:
 * 1. `recipient.campaign.channelConfig.allegatoKey` indica la chiave in `extraData`
 *    che contiene il nome file da usare.
 * 2. Fallback: scansiona tutti i valori di `extraData` e usa il primo che termina
 *    con `.pdf` (case-insensitive).
 *
 * Usata sia da `AttachmentService` (per servire il download) sia da
 * `RetentionCleanupService` (per individuare i file da eliminare alla scadenza),
 * in modo che entrambi concordino su quali destinatari hanno un allegato personalizzato.
 */
export function resolveCustomAttachmentFilename(recipient: Recipient): string | undefined {
  const allegatoKey = recipient.campaign?.channelConfig?.['allegatoKey'] as string | undefined;
  if (allegatoKey && recipient.extraData?.[allegatoKey]) {
    return String(recipient.extraData[allegatoKey]);
  }

  for (const val of Object.values(recipient.extraData ?? {})) {
    if (typeof val === 'string' && val.toLowerCase().endsWith('.pdf')) {
      return val;
    }
  }

  return undefined;
}

@Injectable()
export class AttachmentService {
  private readonly logger = new Logger(AttachmentService.name);

  async generatePdfBuffer(recipient: Recipient): Promise<Buffer> {
    // Verifichiamo se esiste un allegato PDF personalizzato caricato sul disco
    const customFilename = resolveCustomAttachmentFilename(recipient);

    if (customFilename) {
      const filePath = join(getUploadsDir(recipient.campaignId), customFilename);
      if (fs.existsSync(filePath)) {
        this.logger.log(`Serving custom uploaded PDF attachment: ${filePath}`);
        return fs.readFileSync(filePath);
      }
    }

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage();
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

    page.drawText('COMUNE DI MONTESILVANO', { x: 50, y: 750, size: 16, font: fontBold, color: rgb(0, 0.2, 0.4) });
    page.drawText('ComunicaPA — Hub di Trasmissione Comunicazioni', { x: 50, y: 730, size: 10, font: fontRegular, color: rgb(0.5, 0.5, 0.5) });
    page.drawLine({ start: { x: 50, y: 715 }, end: { x: 550, y: 715 }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
    page.drawText(`Destinatario: ${recipient.fullName || 'N/D'}`, { x: 50, y: 680, size: 11, font: fontBold });
    page.drawText(`Codice Fiscale: ${recipient.codiceFiscale}`, { x: 50, y: 660, size: 11, font: fontRegular });
    if (recipient.email) {
      page.drawText(`Email: ${recipient.email}`, { x: 50, y: 645, size: 11, font: fontRegular });
    }
    if (recipient.pec) {
      page.drawText(`PEC: ${recipient.pec}`, { x: 50, y: 630, size: 11, font: fontRegular });
    }
    page.drawText("Oggetto dell'avviso:", { x: 50, y: 580, size: 11, font: fontBold, color: rgb(0, 0.2, 0.4) });
    page.drawText(recipient.campaign.name, { x: 50, y: 560, size: 12, font: fontBold });
    page.drawText('Dettaglio comunicazione:', { x: 50, y: 520, size: 11, font: fontBold });
    const description = recipient.campaign.description || 'Nessuna descrizione specificata.';
    page.drawText(description, { x: 50, y: 500, size: 11, font: fontRegular, maxWidth: 500, lineHeight: 14 });
    page.drawText(`PROTOCOLLO GENERALE - N. COM_${recipient.id.slice(0, 8).toUpperCase()}`, { x: 310, y: 750, size: 8, font: fontBold, color: rgb(0.8, 0.1, 0.1) });
    page.drawLine({ start: { x: 50, y: 150 }, end: { x: 550, y: 150 }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
    page.drawText(`Identificativo notifica: ${recipient.id}`, { x: 50, y: 130, size: 9, font: fontRegular, color: rgb(0.5, 0.5, 0.5) });
    page.drawText(`Data invio: ${recipient.createdAt.toLocaleDateString('it-IT')}`, { x: 50, y: 115, size: 9, font: fontRegular, color: rgb(0.5, 0.5, 0.5) });
    page.drawText(`Canale di trasmissione: ${recipient.campaign.channelType}`, { x: 50, y: 100, size: 9, font: fontRegular, color: rgb(0.5, 0.5, 0.5) });

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
  }
}
