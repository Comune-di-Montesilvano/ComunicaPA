import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Recipient } from '../entities/recipient.entity';
import { Campaign } from '../entities/campaign.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { CitizenController } from './citizen.controller';
import { CitizenService } from './citizen.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Recipient, Campaign, NotificationAttempt]),
    AuthModule,
  ],
  controllers: [CitizenController],
  providers: [CitizenService],
  exports: [CitizenService],
})
export class CitizenModule {}
