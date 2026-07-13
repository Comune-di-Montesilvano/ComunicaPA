import { Module } from '@nestjs/common';
import { PdndAuthService } from './pdnd-auth.service';

@Module({
  providers: [PdndAuthService],
  exports: [PdndAuthService],
})
export class PdndModule {}
