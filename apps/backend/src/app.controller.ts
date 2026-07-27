import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './auth/decorators/public.decorator';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

function getSoftwareVersion(): string {
  if (process.env['APP_VERSION'] && process.env['APP_VERSION'] !== 'dev') {
    return process.env['APP_VERSION'];
  }
  try {
    const candidates = [
      join(process.cwd(), 'publiccode.yml'),
      join(process.cwd(), '..', '..', 'publiccode.yml'),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        const content = readFileSync(p, 'utf-8');
        const match = content.match(/softwareVersion:\s*["']?([^"'\s]+)["']?/);
        if (match && match[1]) return match[1];
      }
    }
  } catch {
    // fallback
  }
  return 'dev';
}

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
      version: getSoftwareVersion(),
      isLdapMock: process.env['LDAP_HOST'] === 'mock',
    };
  }
}
