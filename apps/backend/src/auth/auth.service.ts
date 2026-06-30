import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { JwtOperatorPayload, CitizenTokenClaims } from '@comunicapa/shared-types';
import { LdapService } from './ldap/ldap.service';
import type { LoginDto } from './dto/login.dto';
import type { AuthResponseDto } from './dto/auth-response.dto';

@Injectable()
export class AuthService {
  private static readonly EXPIRES_IN_SECONDS = 8 * 60 * 60;

  constructor(
    private readonly ldapService: LdapService,
    private readonly jwtService: JwtService,
  ) {}

  async loginWithLdap(dto: LoginDto): Promise<AuthResponseDto> {
    const ldapUser = await this.ldapService.authenticate(dto.username, dto.password);

    const payload: Omit<JwtOperatorPayload, 'iat' | 'exp'> = {
      sub: ldapUser.username,
      username: ldapUser.username,
      role: ldapUser.role,
      type: 'operator',
    };

    const token = this.jwtService.sign(payload);

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: AuthService.EXPIRES_IN_SECONDS,
      username: ldapUser.username,
      role: ldapUser.role,
    };
  }

  async generateCitizenToken(dto: {
    codiceFiscale: string;
    name?: string;
    email?: string;
  }): Promise<{ access_token: string }> {
    const payload: Omit<CitizenTokenClaims, 'iat' | 'exp'> = {
      sub: dto.codiceFiscale,
      codiceFiscale: dto.codiceFiscale.toUpperCase().trim(),
      name: dto.name || 'Cittadino Simulato',
      email: dto.email || 'cittadino@example.com',
    };

    const token = this.jwtService.sign(payload);

    return {
      access_token: token,
    };
  }
}
