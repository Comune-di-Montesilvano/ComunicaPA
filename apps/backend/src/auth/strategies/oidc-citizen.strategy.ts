import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import type { CitizenTokenClaims } from '@comunicapa/shared-types';
import type { AppConfiguration } from '../../config/configuration';

@Injectable()
export class OidcCitizenStrategy extends PassportStrategy(Strategy, 'oidc-citizen') {
  constructor(config: ConfigService<AppConfiguration, true>) {
    const jwksUri = config.get('oidc.jwksUri', { infer: true });
    const issuer = config.get('oidc.issuer', { infer: true });
    const audience = config.get('oidc.audience', { infer: true });
    const jwtSecret = config.get('jwt.secret', { infer: true });

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      audience: audience || undefined,
      issuer: issuer || undefined,
      algorithms: ['RS256', 'HS256'],
      secretOrKeyProvider: jwksUri
        ? passportJwtSecret({
            cache: true,
            rateLimit: true,
            jwksRequestsPerMinute: 10,
            jwksUri,
          })
        : (_req: unknown, _rawJwt: unknown, done: (err: null, secret: string) => void) => {
            done(null, jwtSecret);
          },
    });
  }

  validate(payload: Record<string, unknown>): CitizenTokenClaims {
    const codiceFiscale = String(
      payload['fiscal_number'] ??
        payload['codice_fiscale'] ??
        payload['cf'] ??
        '',
    ).toUpperCase();

    return {
      sub: String(payload['sub'] ?? ''),
      codiceFiscale,
      email: payload['email'] ? String(payload['email']) : undefined,
      name: payload['name'] ? String(payload['name']) : undefined,
    };
  }
}
