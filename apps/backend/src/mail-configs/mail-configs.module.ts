import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailServerConfig } from '../entities/mail-server-config.entity';
import { MailConfigsService } from './mail-configs.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([MailServerConfig])],
  providers: [MailConfigsService],
  exports: [MailConfigsService],
})
export class MailConfigsModule {}
