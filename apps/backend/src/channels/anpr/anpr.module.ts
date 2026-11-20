import { Module } from '@nestjs/common';
import { PdndModule } from '../../pdnd/pdnd.module.js';
import { AnprService } from './anpr.service.js';
import { AnprMassivoService } from './anpr-massivo.service.js';

@Module({
  imports: [PdndModule],
  providers: [AnprService, AnprMassivoService],
  exports: [AnprService, AnprMassivoService],
})
export class AnprModule {}
