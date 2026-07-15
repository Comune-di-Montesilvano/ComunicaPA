import { Module } from '@nestjs/common';
import { PdndModule } from '../../pdnd/pdnd.module';
import { SendLegalFactsService } from './send-legal-facts.service';

@Module({
  imports: [PdndModule],
  providers: [SendLegalFactsService],
  exports: [SendLegalFactsService],
})
export class SendLegalFactsModule {}
