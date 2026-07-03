import { Body, Controller, Get, HttpCode, HttpStatus, Post, Request, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { OidcFlowService } from './oidc/oidc-flow.service';
import { AppSettingsService } from '../settings/app-settings.service';
import { LoginDto } from './dto/login.dto';
import type { AuthResponseDto } from './dto/auth-response.dto';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import type { AppConfiguration } from '../config/configuration';
import { Public } from './decorators/public.decorator';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly oidcFlow: OidcFlowService,
    private readonly appSettings: AppSettingsService,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.authService.loginWithLdap(dto);
  }

  /** Modalità auth cittadini: la SPA decide se mostrare SPID reale o il simulatore dev. */
  @Public()
  @Get('citizen/config')
  async citizenConfig(): Promise<{ mode: 'oidc' | 'mock'; logoutUrl: string | null }> {
    const mode = this.config.get('ldap.host', { infer: true }) === 'mock' ? 'mock' : 'oidc';
    const logoutUrl = await this.appSettings.get<string>('oidc.logoutUrl');
    return { mode, logoutUrl: logoutUrl || null };
  }

  @Public()
  @Get('citizen/oidc/start')
  async oidcStart(@Res() res: Response): Promise<void> {
    res.redirect(await this.oidcFlow.buildAuthorizationUrl());
  }

  @Public()
  @Post('citizen/oidc/callback')
  @HttpCode(HttpStatus.OK)
  oidcCallback(@Body() dto: { code: string; state: string }): Promise<{ access_token: string }> {
    return this.oidcFlow.exchangeCode(dto.code, dto.state);
  }

  /** Simulatore dev: attivo SOLO con LDAP_HOST=mock (vedi AuthService). */
  @Public()
  @Post('citizen/login')
  @HttpCode(HttpStatus.OK)
  citizenLogin(
    @Body() dto: { codiceFiscale: string; name?: string; email?: string },
  ): Promise<{ access_token: string }> {
    return this.authService.generateCitizenToken(dto);
  }

  @Get('me')
  me(@Request() req: { user: JwtOperatorPayload }): JwtOperatorPayload {
    return req.user;
  }
}
