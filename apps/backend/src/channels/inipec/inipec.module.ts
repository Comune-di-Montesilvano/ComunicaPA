import { Module } from '@nestjs/common';
import { PdndModule } from '../../pdnd/pdnd.module.js';
import { InipecService } from './inipec.service.js';

@Module({
  imports: [PdndModule],
  providers: [InipecService],
  exports: [InipecService],
})
export class InipecModule {}
