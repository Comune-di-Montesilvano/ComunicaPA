import { Module } from '@nestjs/common';
import { AttachmentService } from './attachment.service.js';

@Module({
  providers: [AttachmentService],
  exports: [AttachmentService],
})
export class AttachmentModule {}
