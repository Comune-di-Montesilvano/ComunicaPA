import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IoServiceConfig } from '../entities/io-service-config.entity';
import { IoServicesService } from './io-services.service';
import { IoServicesController } from './io-services.controller';

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
