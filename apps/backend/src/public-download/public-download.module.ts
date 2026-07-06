import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Recipient } from '../entities/recipient.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { AttachmentModule } from '../attachments/attachment.module';
import { PublicDownloadController } from './public-download.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Recipient, DownloadEvent]), AttachmentModule],
  controllers: [PublicDownloadController],
})
export class PublicDownloadModule {}
