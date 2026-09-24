import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import { Redis } from 'ioredis';
import type { Request } from 'express';
import { extractClaimString, sessionKeyForToken } from '../oidc/oidc-flow.service.js';
import { normalizeTaxId, type CitizenSessionClaims, type CitizenSessionContext } from '../citizen-claims.js';
import type { AppConfiguration } from '../../config/configuration.js';
import { AppSettingsService } from '../../settings/app-settings.service.js';

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
      // Serve il token grezzo per ritrovare il contesto di sessione (chiave = hash del token).
      passReqToCallback: true,
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

  async validate(req: Request, payload: Record<string, unknown>): Promise<CitizenSessionClaims> {
    if (process.env.LOG_LEVEL?.toLowerCase() === 'debug') {
      Logger.debug(`OidcCitizenStrategy.validate payload: ${JSON.stringify(payload)}`, OidcCitizenStrategy.name);
    }
    // Trailing slash normalizzato: il claim `iss` reale del provider non ce l'ha
    // mai (convenzione OIDC standard), ma l'operatore può averlo digitato in UI
    // (es. "https://sso.ente.it/") — bug reale: un confronto stringa esatta
    // rifiutava sempre il login con "Issuer OIDC non valido" in quel caso.
    // Stessa normalizzazione già applicata in oidc-flow.service.ts
    // (requireConfig()) per costruire authorize/token/userinfo endpoint.
    const issuer = (await this.settings.get<string>('oidc.issuer'))?.replace(/\/+$/, '');
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

    // Token reali del proxy (verificati via JWKS): identità e tipo di accesso
    // vengono SOLO dal contesto salvato al callback, legato a questo token.
    // I claim del token non bastano: non dicono se la sessione è da cittadino
    // o per conto di un'impresa, e i dati aziendali non vanno mai presi da lì.
    const jwksUri = await this.settings.get<string>('oidc.jwksUri');
    if (jwksUri) {
      return this.claimsFromSessionContext(req, sub, payload);
    }

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

    // Senza JWKS (simulatore dev, token firmato dal backend con JWT_SECRET):
    // i dati impresa, se presenti, li abbiamo scritti noi nel token.
    const isCompany = payload['accessType'] === 'PG' && !!payload['ivaCode'];
    return {
      sub: String(payload['sub'] ?? ''),
      codiceFiscale,
      email: payload['email'] ? String(payload['email']) : undefined,
      name: name || undefined,
      accessType: isCompany ? 'PG' : 'PF',
      ...(isCompany
        ? {
          ivaCode: normalizeTaxId(String(payload['ivaCode'])),
          companyName: payload['companyName'] ? String(payload['companyName']) : undefined,
          registeredOffice: payload['registeredOffice'] ? String(payload['registeredOffice']) : undefined,
        }
        : {}),
    };
  }

  private async claimsFromSessionContext(req: Request, sub: string, payload: Record<string, unknown>): Promise<CitizenSessionClaims> {
    const token = ExtractJwt.fromAuthHeaderAsBearerToken()(req) ?? '';
    const email = payload['email'] ? String(payload['email']) : undefined;

    let context: CitizenSessionContext | null = null;
    try {
      const raw = token ? await this.redis.get(sessionKeyForToken(token)) : null;
      if (raw) context = JSON.parse(raw) as CitizenSessionContext;
    } catch (err) {
      Logger.warn(`Errore lettura contesto sessione OIDC da Redis: ${String(err)}`, OidcCitizenStrategy.name);
    }

    if (context) {
      const isCompany = context.accessType === 'PG';
      return {
        sub,
        codiceFiscale: context.codiceFiscale,
        email,
        name: context.name || undefined,
        accessType: isCompany ? 'PG' : 'PF',
        ...(isCompany ? { ivaCode: context.ivaCode, companyName: context.companyName, registeredOffice: context.registeredOffice } : {}),
      };
    }

    // Transitorio: token emessi prima di questa versione hanno solo la cache
    // per persona `oidc:claims:<sub>` (mai più scritta dai nuovi login, scade
    // entro 8 ore dal deploy). Solo come cittadino: una sessione impresa ha
    // sempre il contesto per token, quindi non può finire qui.
    try {
      const legacy = sub ? await this.redis.get(`oidc:claims:${sub}`) : null;
      if (legacy) {
        const cached = JSON.parse(legacy) as { codiceFiscale?: string; name?: string };
        if (cached.codiceFiscale) {
          return { sub, codiceFiscale: normalizeTaxId(cached.codiceFiscale), email, name: cached.name || undefined, accessType: 'PF' };
        }
      }
    } catch (err) {
      Logger.warn(`Errore lettura claims OIDC legacy da Redis: ${String(err)}`, OidcCitizenStrategy.name);
    }

    // Contesto perso (Redis svuotato/ricreato): mai ricostruire l'identità
    // dal solo token, rischieremmo di degradare una sessione impresa a
    // cittadino senza che l'utente lo sappia. Nuovo login obbligatorio.
    throw new UnauthorizedException('Sessione scaduta: effettua di nuovo l\'accesso');
  }
}
