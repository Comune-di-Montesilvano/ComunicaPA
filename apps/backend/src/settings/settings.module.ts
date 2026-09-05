import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppSetting } from '../entities/app-setting.entity.js';
import { PdndModule } from '../pdnd/pdnd.module.js';
import { InadModule } from '../channels/inad/inad.module.js';
import { RegistroImpreseModule } from '../channels/registro-imprese/registro-imprese.module.js';
import { AppSettingsService } from './app-settings.service.js';
import { SettingsController } from './settings.controller.js';
import { BrandingController } from './branding.controller.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AppSetting]), PdndModule, InadModule, RegistroImpreseModule],
  controllers: [SettingsController, BrandingController],
  providers: [AppSettingsService],
  exports: [AppSettingsService],
})
export class SettingsModule {}
