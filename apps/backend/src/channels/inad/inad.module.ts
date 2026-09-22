import { Module } from '@nestjs/common';
import { PdndModule } from '../../pdnd/pdnd.module.js';
import { InadService } from './inad.service.js';
import { InadVerifyController } from './inad-verify.controller.js';

@Module({
  imports: [PdndModule],
  controllers: [InadVerifyController],
  providers: [InadService],
  exports: [InadService],
})
export class InadModule {}
