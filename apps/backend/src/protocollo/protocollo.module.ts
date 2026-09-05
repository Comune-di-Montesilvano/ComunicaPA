import { Module } from '@nestjs/common';
import { ProtocolloService } from './protocollo.service.js';

@Module({
  providers: [ProtocolloService],
  exports: [ProtocolloService],
})
export class ProtocolloModule {}
