import { Body, Controller, Get, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { OidcFlowService } from './oidc/oidc-flow.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { OidcCallbackDto, CitizenLoginDto } from './dto/oidc.dto';
import type { AppConfiguration } from '../config/configuration';
import { Public } from './decorators/public.decorator';

@Controller('citizen/auth')
export class CitizenAuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly oidcFlow: OidcFlowService,
    private readonly appSettings: AppSettingsService,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  /** Modalità auth cittadini: la SPA decide se mostrare SPID reale o il simulatore dev. */
  @Public()
  @Get('config')
  async citizenConfig(): Promise<{ mode: 'oidc' | 'mock'; logoutUrl: string | null }> {
    const mode = this.config.get('ldap.host', { infer: true }) === 'mock' ? 'mock' : 'oidc';
    const logoutUrl = await this.appSettings.get<string>('oidc.logoutUrl');
    return { mode, logoutUrl: logoutUrl || null };
  }

  @Public()
  @Get('oidc/start')
  async oidcStart(@Res() res: Response): Promise<void> {
    res.redirect(await this.oidcFlow.buildAuthorizationUrl());
  }

  @Public()
  @Post('oidc/callback')
  @HttpCode(HttpStatus.OK)
  oidcCallback(@Body() dto: OidcCallbackDto): Promise<{ access_token: string; claims?: { cf: string; name: string; provider: string } }> {
    return this.oidcFlow.exchangeCode(dto.code, dto.state);
  }

  /** Simulatore dev: attivo SOLO con LDAP_HOST=mock (vedi AuthService). */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  citizenLogin(
    @Body() dto: CitizenLoginDto,
  ): Promise<{ access_token: string }> {
    return this.authService.generateCitizenToken(dto);
  }
}
