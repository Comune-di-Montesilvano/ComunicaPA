import { Module } from '@nestjs/common';
import { InadModule } from '../inad/inad.module.js';
import { AnprModule } from '../anpr/anpr.module.js';
import { RegistroImpreseModule } from '../registro-imprese/registro-imprese.module.js';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module.js';
import { DomicilioService } from './domicilio.service.js';
import { DomicilioController } from './domicilio.controller.js';

// IoServicesService è iniettabile senza importare IoServicesModule: è
// @Global() (vedi io-services.module.ts).
@Module({
  imports: [InadModule, AnprModule, RegistroImpreseModule, AuditLogsModule],
  controllers: [DomicilioController],
  providers: [DomicilioService],
  exports: [DomicilioService],
})
export class DomicilioModule {}
