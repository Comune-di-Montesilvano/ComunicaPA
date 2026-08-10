import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExternalApiClient } from '../entities/external-api-client.entity';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { ExternalApiClientsService } from './external-api-clients.service';
import { AdminExternalClientsController } from './admin-external-clients.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ExternalApiClient]), AuditLogsModule],
  controllers: [AdminExternalClientsController],
  providers: [ExternalApiClientsService],
  exports: [ExternalApiClientsService],
})
export class ExternalApiModule {}
