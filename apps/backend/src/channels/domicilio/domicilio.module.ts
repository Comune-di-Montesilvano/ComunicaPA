import { Module } from '@nestjs/common';
import { InadModule } from '../inad/inad.module';
import { AnprModule } from '../anpr/anpr.module';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { DomicilioService } from './domicilio.service';
import { DomicilioController } from './domicilio.controller';

// IoServicesService è iniettabile senza importare IoServicesModule: è
// @Global() (vedi io-services.module.ts).
@Module({
  imports: [InadModule, AnprModule, AuditLogsModule],
  controllers: [DomicilioController],
  providers: [DomicilioService],
})
export class DomicilioModule {}
