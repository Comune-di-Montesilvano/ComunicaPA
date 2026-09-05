import { Module } from '@nestjs/common';
import { PdndModule } from '../../pdnd/pdnd.module.js';
import { AnprService } from './anpr.service.js';

@Module({
  imports: [PdndModule],
  providers: [AnprService],
  exports: [AnprService],
})
export class AnprModule {}
