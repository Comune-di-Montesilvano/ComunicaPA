import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppSetting } from '../entities/app-setting.entity';
import { PdndModule } from '../pdnd/pdnd.module';
import { InadModule } from '../channels/inad/inad.module';
import { AppSettingsService } from './app-settings.service';
import { SettingsController } from './settings.controller';
import { BrandingController } from './branding.controller';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AppSetting]), PdndModule, InadModule],
  controllers: [SettingsController, BrandingController],
  providers: [AppSettingsService],
  exports: [AppSettingsService],
})
export class SettingsModule {}
