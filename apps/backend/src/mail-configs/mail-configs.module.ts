import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailServerConfig } from '../entities/mail-server-config.entity';
import { MailConfigsService } from './mail-configs.service';
import { MailConfigsController } from './mail-configs.controller';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([MailServerConfig])],
  controllers: [MailConfigsController],
  providers: [MailConfigsService],
  exports: [MailConfigsService],
})
export class MailConfigsModule {}
