import { Module } from '@nestjs/common';
import { ProtocolloService } from './protocollo.service';

@Module({
  providers: [ProtocolloService],
  exports: [ProtocolloService],
})
export class ProtocolloModule {}
