import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Recipient } from '../entities/recipient.entity.js';
import { DownloadEvent } from '../entities/download-event.entity.js';
import { AttachmentModule } from '../attachments/attachment.module.js';
import { PublicDownloadController } from './public-download.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([Recipient, DownloadEvent]), AttachmentModule],
  controllers: [PublicDownloadController],
})
export class PublicDownloadModule {}
