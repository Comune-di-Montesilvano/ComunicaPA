import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppSetting } from '../entities/app-setting.entity';
import { ChannelModule } from '../channels/channel.module';
import { AppSettingsService } from './app-settings.service';
import { SettingsController } from './settings.controller';
import { BrandingController } from './branding.controller';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AppSetting]), ChannelModule],
  controllers: [SettingsController, BrandingController],
  providers: [AppSettingsService],
  exports: [AppSettingsService],
})
export class SettingsModule {}
