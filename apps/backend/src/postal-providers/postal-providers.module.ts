import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostalProviderConfig } from '../entities/postal-provider-config.entity.js';
import { GlobalComClientModule } from '../channels/postal/globalcom-client.module.js';
import { PostalProvidersService } from './postal-providers.service.js';
import { PostalProvidersController } from './postal-providers.controller.js';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([PostalProviderConfig]), GlobalComClientModule],
  controllers: [PostalProvidersController],
  providers: [PostalProvidersService],
  exports: [PostalProvidersService],
})
export class PostalProvidersModule {}
