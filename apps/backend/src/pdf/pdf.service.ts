import { Injectable, Logger, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);
  private readonly storagePath = process.env['PDF_STORAGE_PATH'] ?? '/data/attachments';

  async stampPdfBytes(pdfBytes: Uint8Array, stamp: string): Promise<Uint8Array> {
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();
    const firstPage = pages[0];
    const { height } = firstPage.getSize();

    firstPage.drawText(stamp, {
      x: 50,
      y: height - 50,
      size: 10,
      font,
      color: rgb(0.2, 0.2, 0.6),
    });

    return pdfDoc.save();
  }

  async stampWithProtocol(fileId: string, stamp: string): Promise<string> {
    const inputPath = join(this.storagePath, `${fileId}.pdf`);
    const stampedId = `${fileId}_stamped_${Date.now()}`;
    const outputPath = join(this.storagePath, `${stampedId}.pdf`);

    let pdfBytes: Buffer;
    try {
      pdfBytes = await readFile(inputPath);
    } catch {
      throw new NotFoundException(`PDF not found: ${fileId}`);
    }

    const stamped = await this.stampPdfBytes(new Uint8Array(pdfBytes), stamp);

    await mkdir(this.storagePath, { recursive: true });

    try {
      await writeFile(outputPath, stamped);
    } catch (err) {
      this.logger.error(`Failed to write stamped PDF ${stampedId}`, err instanceof Error ? err.message : String(err));
      throw new InternalServerErrorException(`Failed to write stamped PDF`);
    }

    this.logger.log(`Stamped PDF: ${stampedId}`);
    return stampedId;
  }
}
