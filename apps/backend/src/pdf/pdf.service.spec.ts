import { BadRequestException } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { PDFDocument } from 'pdf-lib';

describe('PdfService', () => {
  let service: PdfService;

  beforeEach(() => {
    service = new PdfService();
  });

  it('is defined', () => {
    expect(service).toBeDefined();
  });

  it('stampPdfBytes returns valid Uint8Array larger than input', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);
    const bytes = await pdfDoc.save();

    const stamped = await service.stampPdfBytes(new Uint8Array(bytes), 'SEGNATURA/2024/0001');

    expect(stamped).toBeInstanceOf(Uint8Array);
    expect(stamped.length).toBeGreaterThan(bytes.length);
  });

  it('stampPdfBytes preserves page count on single-page PDF', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);
    const bytes = await pdfDoc.save();

    const stamped = await service.stampPdfBytes(new Uint8Array(bytes), 'TEST STAMP');
    const reloaded = await PDFDocument.load(stamped);

    expect(reloaded.getPageCount()).toBe(1);
  });

  it('stampPdfBytes preserves page count on multi-page PDF', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([595, 842]);
    pdfDoc.addPage([595, 842]);
    const bytes = await pdfDoc.save();

    const stamped = await service.stampPdfBytes(new Uint8Array(bytes), 'PAGE 2 INTACT');
    const reloaded = await PDFDocument.load(stamped);

    expect(reloaded.getPageCount()).toBe(2);
  });

  describe('stampWithProtocol — path traversal guard', () => {
    it('throws BadRequestException for fileId with ..', async () => {
      await expect(
        service.stampWithProtocol('../etc/passwd', 'STAMP'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for fileId with forward slash', async () => {
      await expect(
        service.stampWithProtocol('some/path', 'STAMP'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for fileId with backslash', async () => {
      await expect(
        service.stampWithProtocol('some\\path', 'STAMP'),
      ).rejects.toThrow(BadRequestException);
    });

    it('does not throw BadRequestException for a clean fileId', async () => {
      // A clean fileId will proceed past the guard and fail on file-not-found
      await expect(
        service.stampWithProtocol('clean-file-id', 'STAMP'),
      ).rejects.toThrow(); // NotFoundException from readFile, not BadRequestException
      await expect(
        service.stampWithProtocol('clean-file-id', 'STAMP'),
      ).rejects.not.toThrow(BadRequestException);
    });
  });
});
