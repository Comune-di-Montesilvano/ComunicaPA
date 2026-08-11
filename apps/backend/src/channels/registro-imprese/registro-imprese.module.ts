import { Module } from '@nestjs/common';
import { PdndModule } from '../../pdnd/pdnd.module';
import { RegistroImpreseService } from './registro-imprese.service';

@Module({
  imports: [PdndModule],
  providers: [RegistroImpreseService],
  exports: [RegistroImpreseService],
})
export class RegistroImpreseModule {}
