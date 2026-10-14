import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { RemoteSignJob } from '../entities/remote-sign-job.entity.js';
import { AuditLogsModule } from '../audit-logs/audit-logs.module.js';
import { ArubaSignClient } from './aruba-sign.client.js';
import { RemoteSignService } from './remote-sign.service.js';
import { RemoteSignProcessor } from './remote-sign.processor.js';
import { RemoteSignController } from './remote-sign.controller.js';
import { SignedAttachmentsController } from './signed-attachments.controller.js';
import { SignedAttachmentsService } from './signed-attachments.service.js';
import { RemoteSignReconcileService } from './remote-sign-reconcile.service.js';
import { REMOTE_SIGN_QUEUE } from './remote-sign-job.types.js';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([Campaign, Recipient, RemoteSignJob]),
    BullModule.registerQueue({ name: REMOTE_SIGN_QUEUE }),
    AuditLogsModule,
  ],
  controllers: [RemoteSignController, SignedAttachmentsController],
  providers: [ArubaSignClient, RemoteSignService, RemoteSignProcessor, RemoteSignReconcileService, SignedAttachmentsService],
  exports: [RemoteSignService],
})
export class RemoteSignModule {}
