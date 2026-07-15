import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostalProviderConfig } from '../entities/postal-provider-config.entity';
import { GlobalComClientModule } from '../channels/postal/globalcom-client.module';
import { PostalProvidersService } from './postal-providers.service';
import { PostalProvidersController } from './postal-providers.controller';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([PostalProviderConfig]), GlobalComClientModule],
  controllers: [PostalProvidersController],
  providers: [PostalProvidersService],
  exports: [PostalProvidersService],
})
export class PostalProvidersModule {}
