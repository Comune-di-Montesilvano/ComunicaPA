import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IoServiceConfig } from '../entities/io-service-config.entity.js';
import { IoServicesService } from './io-services.service.js';
import { IoServicesController } from './io-services.controller.js';

// @Global(): AppIoStrategy (in ChannelModule) inietta IoServicesService senza importare
// esplicitamente questo modulo — stesso pattern di MailConfigsModule.
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([IoServiceConfig])],
  controllers: [IoServicesController],
  providers: [IoServicesService],
  exports: [IoServicesService],
})
export class IoServicesModule {}
