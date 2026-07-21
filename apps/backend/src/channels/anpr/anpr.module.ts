import { Module } from '@nestjs/common';
import { PdndModule } from '../../pdnd/pdnd.module';
import { AnprService } from './anpr.service';

@Module({
  imports: [PdndModule],
  providers: [AnprService],
  exports: [AnprService],
})
export class AnprModule {}
