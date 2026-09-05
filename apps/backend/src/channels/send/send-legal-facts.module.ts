import { Module } from '@nestjs/common';
import { PdndModule } from '../../pdnd/pdnd.module.js';
import { SendLegalFactsService } from './send-legal-facts.service.js';

@Module({
  imports: [PdndModule],
  providers: [SendLegalFactsService],
  exports: [SendLegalFactsService],
})
export class SendLegalFactsModule {}
