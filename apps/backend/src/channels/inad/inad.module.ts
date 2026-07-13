import { Module } from '@nestjs/common';
import { PdndModule } from '../../pdnd/pdnd.module';
import { InadService } from './inad.service';

@Module({
  imports: [PdndModule],
  providers: [InadService],
  exports: [InadService],
})
export class InadModule {}
