import {
  BadGatewayException,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import Redis from 'ioredis';
import type { AppConfiguration } from '../../config/configuration';
import { AppSettingsService } from '../../settings/app-settings.service';

interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

const STATE_TTL_SECONDS = 300;
const DISCOVERY_CACHE_MS = 10 * 60 * 1000;

/**
 * Flusso Authorization Code + PKCE verso il proxy OIDC (SPID/CIE).
 * Lo scambio del code avviene qui nel backend: il client_secret non
 * raggiunge mai il browser. Il token restituito alla SPA è l'id_token
 * del provider, che OidcCitizenStrategy valida già (JWKS/iss/aud).
 */
@Injectable()
export class OidcFlowService implements OnModuleDestroy {
  private readonly logger = new Logger(OidcFlowService.name);
  private readonly redis: Redis;
  private discoveryCache: { issuer: string; endpoints: OidcEndpoints; fetchedAt: number } | null =
    null;

  constructor(
    private readonly settings: AppSettingsService,
    config: ConfigService<AppConfiguration, true>,
  ) {
    this.redis = new Redis(config.get('redis.url', { infer: true }), {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }

  /** Costruisce l'URL di authorize e registra state+verifier su Redis. */
  async buildAuthorizationUrl(): Promise<string> {
    const { issuer, clientId, redirectUri } = await this.requireConfig();
    const endpoints = await this.discoverEndpoints(issuer);

    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    await this.redis.set(`oidc:state:${state}`, verifier, 'EX', STATE_TTL_SECONDS);

    const url = new URL(endpoints.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  /** Consuma lo state e scambia il code al token endpoint del proxy. */
  async exchangeCode(code: string, state: string): Promise<{ access_token: string }> {
    if (!code || !state) {
      throw new UnauthorizedException('code e state richiesti');
    }

    const verifier = await this.redis.getdel(`oidc:state:${state}`);
    if (!verifier) {
      throw new UnauthorizedException('Sessione di login scaduta o non valida: riprova');
    }

    const { issuer, clientId, clientSecret, redirectUri } = await this.requireConfig();
    const endpoints = await this.discoverEndpoints(issuer);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    if (clientSecret) {
      body.set('client_secret', clientSecret);
    }

    let res: Response;
    try {
      res = await fetch(endpoints.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.logger.error(`Token endpoint irraggiungibile: ${String(err)}`);
      throw new BadGatewayException('Provider OIDC non raggiungibile');
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error(`Token endpoint ${res.status}: ${detail.slice(0, 500)}`);
      throw new BadGatewayException('Scambio del codice OIDC fallito');
    }

    const payload = (await res.json()) as { id_token?: string; access_token?: string };
    const token = payload.id_token ?? payload.access_token;
    if (!token) {
      throw new BadGatewayException('Il provider OIDC non ha restituito un token');
    }
    return { access_token: token };
  }

  private async requireConfig(): Promise<{
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }> {
    const [issuer, clientId, clientSecret, citizenOrigin] = await Promise.all([
      this.settings.get<string>('oidc.issuer'),
      this.settings.get<string>('oidc.clientId'),
      this.settings.get<string>('oidc.clientSecret'),
      this.settings.get<string>('system.citizenPublicUrl'),
    ]);

    if (!issuer || !clientId) {
      throw new ServiceUnavailableException(
        'OIDC non configurato: impostare Issuer e Client ID dalla UI admin',
      );
    }
    if (!citizenOrigin) {
      throw new ServiceUnavailableException(
        'CITIZEN_ORIGIN non impostato nel .env del server: impossibile costruire la Redirect URI',
      );
    }

    return {
      issuer: issuer.replace(/\/+$/, ''),
      clientId,
      clientSecret,
      redirectUri: `${citizenOrigin.replace(/\/+$/, '')}/oidc/callback`,
    };
  }

  private async discoverEndpoints(issuer: string): Promise<OidcEndpoints> {
    const cached = this.discoveryCache;
    if (cached && cached.issuer === issuer && Date.now() - cached.fetchedAt < DISCOVERY_CACHE_MS) {
      return cached.endpoints;
    }

    let endpoints: OidcEndpoints | null = null;
    try {
      const res = await fetch(`${issuer}/.well-known/openid-configuration`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const doc = (await res.json()) as {
          authorization_endpoint?: string;
          token_endpoint?: string;
        };
        if (doc.authorization_endpoint && doc.token_endpoint) {
          endpoints = {
            authorizationEndpoint: doc.authorization_endpoint,
            tokenEndpoint: doc.token_endpoint,
          };
        }
      }
    } catch {
      // discovery assente: fallback convenzionale sotto
    }

    if (!endpoints) {
      this.logger.warn(`Discovery OIDC non disponibile su ${issuer}: uso /authorize e /token`);
      endpoints = {
        authorizationEndpoint: `${issuer}/authorize`,
        tokenEndpoint: `${issuer}/token`,
      };
    }

    this.discoveryCache = { issuer, endpoints, fetchedAt: Date.now() };
    return endpoints;
  }
}
