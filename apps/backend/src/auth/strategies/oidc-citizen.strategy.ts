import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import Redis from 'ioredis';
import { extractClaimString } from '../oidc/oidc-flow.service';
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
  private readonly redis: Redis;

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
              getJwksProvider(jwksUri)(req, rawJwt, (err, secret) => {
                if (err || !secret) {
                  // jwks-rsa inghiotte SigningKeyNotFoundError e mismatch di
                  // algoritmo richiamando il callback con (null, null): senza
                  // questo log il fallimento è silenzioso e jsonwebtoken
                  // rigetta poi il token con un 401 generico privo di dettagli
                  let header = 'non decodificabile';
                  try {
                    const headerPart = String(rawJwt).split('.')[0];
                    header = Buffer.from(headerPart, 'base64').toString('utf8');
                  } catch {
                    // ignora, resta 'non decodificabile'
                  }
                  Logger.error(
                    `Verifica JWKS fallita (header token: ${header}): ${err?.message ?? 'nessuna chiave/secret restituita da jwks-rsa (kid non trovato o algoritmo non supportato)'}`,
                    err?.stack,
                    'OidcCitizenStrategy',
                  );
                }
                done(err, secret);
              });
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

    this.redis = new Redis(config.get('redis.url', { infer: true }), {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });
    this.settings = settings;
  }

  async validate(payload: Record<string, unknown>): Promise<CitizenTokenClaims> {
    if (process.env.LOG_LEVEL?.toLowerCase() === 'debug') {
      Logger.debug(`OidcCitizenStrategy.validate payload: ${JSON.stringify(payload)}`, OidcCitizenStrategy.name);
    }
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

    const sub = String(payload['sub'] ?? '');
    let cachedClaims: { codiceFiscale?: string; name?: string } | null = null;
    if (sub) {
      try {
        const cached = await this.redis.get(`oidc:claims:${sub}`);
        if (cached) {
          cachedClaims = JSON.parse(cached);
          if (process.env.LOG_LEVEL?.toLowerCase() === 'debug') {
            Logger.debug(`OidcCitizenStrategy.validate found cached claims in Redis: ${cached}`, OidcCitizenStrategy.name);
          }
        }
      } catch (err) {
        Logger.warn(`Errore durante il recupero dei claims OIDC da Redis: ${String(err)}`, OidcCitizenStrategy.name);
      }
    }

    // pa-sso-proxy (SATOSA/SPID): fiscal_number in formato "TINIT-<CF>";
    // eIDAS usa anche il claim URI https://attributes.eid.gov.it/fiscal_number
    // SPID usa anche il claim URI https://attributes.spid.gov.it/fiscalNumber
    const rawFiscal = extractClaimString(
      cachedClaims?.codiceFiscale ??
        payload['fiscal_number'] ??
        payload['https://attributes.eid.gov.it/fiscal_number'] ??
        payload['https://attributes.spid.gov.it/fiscalNumber'] ??
        payload['codice_fiscale'] ??
        payload['cf'] ??
        payload['codiceFiscale'] ??
        payload['fiscalNumber'] ??
        payload['fiscalCode'] ??
        '',
    ).toUpperCase();
    // "TIN" + codice paese (TINIT- per l'Italia)
    const codiceFiscale = rawFiscal.replace(/^TIN[A-Z]{2}-/, '');

    // Nome completo: claim name, oppure given_name + family_name (SPID)
    const givenName = extractClaimString(
      payload['given_name'] ??
        payload['first_name'] ??
        payload['givenName'] ??
        '',
    );
    const familyName = extractClaimString(
      payload['family_name'] ??
        payload['last_name'] ??
        payload['sn'] ??
        payload['surname'] ??
        payload['familyName'] ??
        '',
    );
    const name =
      cachedClaims?.name ??
      ((givenName && familyName)
        ? `${givenName} ${familyName}`
        : (extractClaimString(payload['name'] ?? '') ||
           [givenName, familyName].filter(Boolean).join(' ')));

    return {
      sub: String(payload['sub'] ?? ''),
      codiceFiscale,
      email: payload['email'] ? String(payload['email']) : undefined,
      name: name || undefined,
    };
  }
}
