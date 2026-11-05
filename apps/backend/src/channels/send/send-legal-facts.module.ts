import { Module } from '@nestjs/common';
import { PdndModule } from '../../pdnd/pdnd.module.js';
import { SendLegalFactsService } from './send-legal-facts.service.js';
import { PdfExtractorClient } from '../../enrichment/pdf-extractor.client.js';

@Module({
  imports: [PdndModule],
  providers: [SendLegalFactsService, PdfExtractorClient],
  exports: [SendLegalFactsService],
})
export class SendLegalFactsModule {}
