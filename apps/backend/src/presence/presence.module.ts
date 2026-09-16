import { Module } from '@nestjs/common';
import { PresenceService } from './presence.service.js';
import { PresenceController } from './presence.controller.js';

@Module({
  controllers: [PresenceController],
  providers: [PresenceService],
})
export class PresenceModule {}
