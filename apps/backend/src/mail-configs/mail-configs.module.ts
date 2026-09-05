import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailServerConfig } from '../entities/mail-server-config.entity.js';
import { MailConfigsService } from './mail-configs.service.js';
import { MailConfigsController } from './mail-configs.controller.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([MailServerConfig])],
  controllers: [MailConfigsController],
  providers: [MailConfigsService],
  exports: [MailConfigsService],
})
export class MailConfigsModule {}
