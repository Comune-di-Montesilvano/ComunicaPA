import { Module } from '@nestjs/common';
import { PdfService } from './pdf.service.js';

@Module({
  providers: [PdfService],
  exports: [PdfService],
})
export class PdfModule {}
