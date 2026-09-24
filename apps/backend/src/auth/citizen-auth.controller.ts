import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service.js';
import { OidcFlowService, type OidcCallbackResultDto } from './oidc/oidc-flow.service.js';
import { AppSettingsService } from '../settings/app-settings.service.js';
import { OidcCallbackDto, CitizenLoginDto } from './dto/oidc.dto.js';
import type { AppConfiguration } from '../config/configuration.js';
import { Public } from './decorators/public.decorator.js';

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
  async citizenConfig(): Promise<{ mode: 'oidc' | 'mock'; logoutUrl: string | null; legalEntityEnabled: boolean }> {
    const mode = this.config.get('ldap.host', { infer: true }) === 'mock' ? 'mock' : 'oidc';
    const [logoutUrl, legalEntityEnabled] = await Promise.all([
      this.appSettings.get<string>('oidc.logoutUrl'),
      this.appSettings.get<boolean>('oidc.legalEntityEnabled'),
    ]);
    return { mode, logoutUrl: logoutUrl || null, legalEntityEnabled: !!legalEntityEnabled };
  }

  @Public()
  @Get('oidc/start')
  async oidcStart(@Query('type') type: string | undefined, @Res() res: Response): Promise<void> {
    // Unico punto in cui il tipo di accesso arriva dal client: viene salvato
    // con lo state e al callback si usa solo quel valore.
    const { url, state } = await this.oidcFlow.buildAuthorizationUrl(type === 'pg' ? 'PG' : 'PF');
    res.cookie('oidc_state', state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 300 * 1000,
    });
    res.redirect(url);
  }

  @Public()
  @Post('oidc/callback')
  @HttpCode(HttpStatus.OK)
  async oidcCallback(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: OidcCallbackDto,
  ): Promise<OidcCallbackResultDto> {
    const cookieState = this.extractCookie(req, 'oidc_state');
    res.clearCookie('oidc_state', { path: '/' });
    if (dto.error) {
      return this.oidcFlow.resolveProviderError(dto.state, cookieState, dto.error);
    }
    return this.oidcFlow.exchangeCode(dto.code ?? '', dto.state, cookieState);
  }

  private extractCookie(req: Request, name: string): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    const cookies = header.split(';').map((c) => c.trim());
    for (const c of cookies) {
      const [key, ...val] = c.split('=');
      if (key === name) {
        return decodeURIComponent(val.join('='));
      }
    }
    return undefined;
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
