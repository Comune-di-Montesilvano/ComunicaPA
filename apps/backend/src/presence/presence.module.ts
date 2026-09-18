import { Module } from '@nestjs/common';
import { OperatorDirectoryModule } from '../operator-directory/operator-directory.module.js';
import { PresenceService } from './presence.service.js';
import { PresenceController } from './presence.controller.js';

@Module({
  imports: [OperatorDirectoryModule],
  controllers: [PresenceController],
  providers: [PresenceService],
})
export class PresenceModule {}
