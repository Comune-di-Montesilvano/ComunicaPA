import { Module } from '@nestjs/common';
import { PdndModule } from '../../pdnd/pdnd.module.js';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module.js';
import { SendLegalFactsModule } from './send-legal-facts.module.js';
import { SendIunLookupService } from './send-iun-lookup.service.js';
import { SendIunLookupController } from './send-iun-lookup.controller.js';

@Module({
  imports: [PdndModule, AuditLogsModule, SendLegalFactsModule],
  controllers: [SendIunLookupController],
  providers: [SendIunLookupService],
})
export class SendIunLookupModule {}
