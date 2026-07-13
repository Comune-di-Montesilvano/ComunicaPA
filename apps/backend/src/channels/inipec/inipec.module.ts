import { Module } from '@nestjs/common';
import { PdndModule } from '../../pdnd/pdnd.module';
import { InipecService } from './inipec.service';

@Module({
  imports: [PdndModule],
  providers: [InipecService],
  exports: [InipecService],
})
export class InipecModule {}
