import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import type { CitizenTokenClaims } from '@comunicapa/shared-types';
import type { AppConfiguration } from '../../config/configuration';
import { AppSettingsService } from '../../settings/app-settings.service';

// Cache dei secret provider JWKS per URI: ricreato solo quando l'admin cambia
// oidc.jwksUri dalla UI, evitando di ricreare il provider ad ogni richiesta.
const jwksProviderCache = new Map<string, ReturnType<typeof passportJwtSecret>>();

function getJwksProvider(jwksUri: string): ReturnType<typeof passportJwtSecret> {
  let provider = jwksProviderCache.get(jwksUri);
  if (!provider) {
    provider = passportJwtSecret({
      cache: true,
      rateLimit: true,
      jwksRequestsPerMinute: 10,
      jwksUri,
    });
    jwksProviderCache.set(jwksUri, provider);
  }
  return provider;
}

@Injectable()
export class OidcCitizenStrategy extends PassportStrategy(Strategy, 'oidc-citizen') {
  private readonly settings: AppSettingsService;

  constructor(config: ConfigService<AppConfiguration, true>, settings: AppSettingsService) {
    const jwtSecret = config.get('jwt.secret', { infer: true });

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      algorithms: ['RS256', 'HS256'],
      secretOrKeyProvider: (
        req: unknown,
        rawJwt: unknown,
        done: (err: Error | null, secret?: string | Buffer) => void,
      ) => {
        settings
          .get<string>('oidc.jwksUri')
          .then((jwksUri) => {
            if (jwksUri) {
              getJwksProvider(jwksUri)(req, rawJwt, done);
            } else {
              // Fallback dev: senza JWKS i token cittadino sono verificati in
              // HS256 col JWT_SECRET interno — in produzione va segnalato
              if (process.env['NODE_ENV'] === 'production') {
                Logger.warn(
                  'oidc.jwksUri non configurato: verifica token cittadino in fallback HS256 (configurarlo dalla UI admin)',
                  'OidcCitizenStrategy',
                );
              }
              done(null, jwtSecret);
            }
          })
          .catch((err) => done(err));
      },
    });

    this.settings = settings;
  }

  async validate(payload: Record<string, unknown>): Promise<CitizenTokenClaims> {
    const issuer = await this.settings.get<string>('oidc.issuer');
    if (issuer && payload['iss'] !== issuer) {
      throw new UnauthorizedException('Issuer OIDC non valido');
    }

    const audience = await this.settings.get<string>('oidc.audience');
    if (audience) {
      const aud = payload['aud'];
      const audMatches = Array.isArray(aud) ? aud.includes(audience) : aud === audience;
      if (!audMatches) {
        throw new UnauthorizedException('Audience OIDC non valida');
      }
    }

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
