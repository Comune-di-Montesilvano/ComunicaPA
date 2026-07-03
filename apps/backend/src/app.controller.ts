import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './auth/decorators/public.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  getHealth(): string {
    return this.appService.getHealth();
  }

  @Public()
  @Get('version')
  getVersion(): { version: string; isLdapMock: boolean } {
    return {
      version: process.env['APP_VERSION'] ?? 'dev',
      isLdapMock: process.env['LDAP_HOST'] === 'mock',
    };
  }
}
