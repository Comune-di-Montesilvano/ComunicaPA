import { Global, Module } from '@nestjs/common';
import { GlobalComClient } from './globalcom-client.service';

@Global()
@Module({
  providers: [GlobalComClient],
  exports: [GlobalComClient],
})
export class GlobalComClientModule {}
