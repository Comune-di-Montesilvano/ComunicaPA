import { ForbiddenException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { normalizeTaxId, type CitizenSessionClaims } from './citizen-claims.js';
import { LdapService } from './ldap/ldap.service.js';
import { OperatorDirectoryService } from '../operator-directory/operator-directory.service.js';
import { PostalAuthorizedUsersService } from '../postal-authorized-users/postal-authorized-users.service.js';
import type { LoginDto } from './dto/login.dto.js';
import type { AuthResponseDto } from './dto/auth-response.dto.js';
import type { AppConfiguration } from '../config/configuration.js';

@Injectable()
export class AuthService {
  private static readonly EXPIRES_IN_SECONDS = 8 * 60 * 60;

  constructor(
    private readonly ldapService: LdapService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService<AppConfiguration, true>,
    private readonly operatorDirectory: OperatorDirectoryService,
    private readonly postalAuthorizedUsers: PostalAuthorizedUsersService,
  ) {}

  async loginWithLdap(dto: LoginDto): Promise<AuthResponseDto> {
    const ldapUser = await this.ldapService.authenticate(dto.username, dto.password);
    await this.operatorDirectory.upsert(ldapUser.username, ldapUser.displayName);

    const canUsePostal =
      ldapUser.role === 'admin' || (await this.postalAuthorizedUsers.isAuthorized(ldapUser.username));

    const payload: Omit<JwtOperatorPayload, 'iat' | 'exp'> = {
      sub: ldapUser.username,
      username: ldapUser.username,
      displayName: ldapUser.displayName,
      role: ldapUser.role,
      type: 'operator',
    };

    const token = this.jwtService.sign(payload);

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: AuthService.EXPIRES_IN_SECONDS,
      username: ldapUser.username,
      displayName: ldapUser.displayName,
      role: ldapUser.role,
      canUsePostal,
    };
  }

  async generateCitizenToken(dto: {
    codiceFiscale: string;
    name?: string;
    email?: string;
    accessType?: 'PF' | 'PG';
    ivaCode?: string;
    companyName?: string;
    registeredOffice?: string;
  }): Promise<{ access_token: string }> {
    // Simulatore consentito solo in sviluppo locale, come le credenziali operatore mock
    if (this.config.get('ldap.host', { infer: true }) !== 'mock') {
      throw new ForbiddenException('Login simulato disabilitato: usare SPID/CIE');
    }
    const isCompany = dto.accessType === 'PG' && !!dto.ivaCode;
    const payload: Omit<CitizenSessionClaims, 'iat' | 'exp'> = {
      sub: dto.codiceFiscale,
      codiceFiscale: dto.codiceFiscale.toUpperCase().trim(),
      name: dto.name || 'Cittadino Simulato',
      email: dto.email || 'cittadino@example.com',
      ...(isCompany
        ? {
          accessType: 'PG' as const,
          ivaCode: normalizeTaxId(dto.ivaCode!),
          companyName: dto.companyName || 'Impresa Simulata SRL',
          registeredOffice: dto.registeredOffice || 'Via Roma 1, 65015 Montesilvano (PE)',
        }
        : {}),
    };

    const token = this.jwtService.sign(payload);

    return {
      access_token: token,
    };
  }
}
