import { Injectable, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { AppSettingsService } from '../settings/app-settings.service';
import type { SettingKey } from '../settings/settings.registry';

export type PdndEnvironment = 'test' | 'prod';

interface CachedVoucher {
  accessToken: string;
  expiresAt: number;
}

/**
 * Client PDND condiviso: le credenziali (client_id/kid/chiave privata) sono
 * uniche per ente, ma un client può essere associato a più finalità
 * ("purpose") — SEND, e in futuro INAD/INIPEC. Il purposeId arriva quindi dal
 * chiamante invece di essere letto internamente.
 */
@Injectable()
export class PdndAuthService {
  private readonly logger = new Logger(PdndAuthService.name);
  private readonly cache = new Map<string, CachedVoucher>();

  constructor(private readonly settings: AppSettingsService) {}

  /** Restituisce un voucher PDND valido per (env, purposeId), riusando la cache se non scaduto (margine 5s). */
  async getVoucher(env: PdndEnvironment, purposeId: string, forceRefresh = false): Promise<string> {
    const cacheKey = `${env}:${purposeId}`;
    const cached = this.cache.get(cacheKey);
    if (!forceRefresh && cached && cached.expiresAt > Date.now() + 5_000) {
      return cached.accessToken;
    }

    const prefix = `pdnd.${env}`;
    const [tokenUrl, audience, clientId, kid, privateKey] = await Promise.all([
      this.settings.get<string>(`${prefix}.tokenUrl` as SettingKey),
      this.settings.get<string>(`${prefix}.audience` as SettingKey),
      this.settings.get<string>(`${prefix}.clientId` as SettingKey),
      this.settings.get<string>(`${prefix}.kid` as SettingKey),
      this.settings.get<string>(`${prefix}.privateKey` as SettingKey),
    ]);

    const missing = Object.entries({ tokenUrl, audience, clientId, kid, purposeId, privateKey })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(`Configurazione PDND (${env}) incompleta: mancano ${missing.join(', ')}`);
    }

    const clientAssertion = jwt.sign(
      {
        iss: clientId,
        sub: clientId,
        aud: audience,
        purposeId,
        jti: randomUUID(),
        iat: Math.floor(Date.now() / 1000),
      },
      privateKey,
      { algorithm: 'RS256', expiresIn: 60, keyid: kid },
    );

    const body = new URLSearchParams({
      client_id: clientId,
      client_assertion: clientAssertion,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      grant_type: 'client_credentials',
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await response.text();

    if (!response.ok) {
      this.logger.warn(`Voucher PDND (${env}) fallito: HTTP ${response.status} — ${text}`);
      throw new Error(`Richiesta voucher PDND fallita: HTTP ${response.status} — ${text.slice(0, 500)}`);
    }

    let data: { access_token?: string; expires_in?: number };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Risposta PDND non valida (non JSON): ${text.slice(0, 200)}`);
    }
    if (!data.access_token) {
      throw new Error(`Risposta PDND priva di access_token: ${text.slice(0, 200)}`);
    }

    const expiresAt = Date.now() + (data.expires_in ?? 600) * 1000;
    this.cache.set(cacheKey, { accessToken: data.access_token, expiresAt });
    this.logger.log(`Voucher PDND (${env}) ottenuto, valido ${data.expires_in ?? 600}s`);
    return data.access_token;
  }

  /** JWK pubblica (RFC 7517) derivata dalla chiave privata PDND, usata nell'header delle DPoP proof. */
  private publicJwk(privateKey: string): Record<string, string> {
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as Record<string, string>;
    return { kty: jwk['kty'], n: jwk['n'], e: jwk['e'] };
  }

  /** DPoP proof (RFC 9449) firmata con la chiave privata PDND — stesso alg RS256, mai un `kid` nell'header (si usa `jwk` inline). */
  private buildDpopProof(privateKey: string, htm: string, htu: string, extraClaims: Record<string, unknown> = {}): string {
    return jwt.sign(
      { htm, htu, iat: Math.floor(Date.now() / 1000), jti: randomUUID(), ...extraClaims },
      privateKey,
      { algorithm: 'RS256', header: { typ: 'dpop+jwt', jwk: this.publicJwk(privateKey) } as unknown as jwt.JwtHeader },
    );
  }

  /**
   * Voucher PDND in modalità DPoP (RFC 9449): il token è legato alla chiave
   * privata del client, non spendibile da chi lo intercetta. Richiesto da
   * alcune finalità (es. ANPR C020) a scelta del fruitore in fase di
   * richiesta voucher — non deducibile dallo yaml dell'erogatore, che
   * dichiara solo lo schema bearer standard. Cache separata da getVoucher()
   * (voucher standard), stesso margine di scadenza.
   */
  async getVoucherDpop(env: PdndEnvironment, purposeId: string, forceRefresh = false): Promise<string> {
    const cacheKey = `dpop:${env}:${purposeId}`;
    const cached = this.cache.get(cacheKey);
    if (!forceRefresh && cached && cached.expiresAt > Date.now() + 5_000) {
      return cached.accessToken;
    }

    const prefix = `pdnd.${env}`;
    const [tokenUrl, audience, clientId, kid, privateKey] = await Promise.all([
      this.settings.get<string>(`${prefix}.tokenUrl` as SettingKey),
      this.settings.get<string>(`${prefix}.audience` as SettingKey),
      this.settings.get<string>(`${prefix}.clientId` as SettingKey),
      this.settings.get<string>(`${prefix}.kid` as SettingKey),
      this.settings.get<string>(`${prefix}.privateKey` as SettingKey),
    ]);

    const missing = Object.entries({ tokenUrl, audience, clientId, kid, purposeId, privateKey })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(`Configurazione PDND (${env}) incompleta: mancano ${missing.join(', ')}`);
    }

    const clientAssertion = jwt.sign(
      { iss: clientId, sub: clientId, aud: audience, purposeId, jti: randomUUID(), iat: Math.floor(Date.now() / 1000) },
      privateKey,
      { algorithm: 'RS256', expiresIn: 60, keyid: kid },
    );
    const dpopProof = this.buildDpopProof(privateKey, 'POST', tokenUrl);

    const body = new URLSearchParams({
      client_id: clientId,
      client_assertion: clientAssertion,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      grant_type: 'client_credentials',
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: dpopProof },
      body,
    });
    const text = await response.text();

    if (!response.ok) {
      this.logger.warn(`Voucher DPoP PDND (${env}) fallito: HTTP ${response.status} — ${text}`);
      throw new Error(`Richiesta voucher DPoP PDND fallita: HTTP ${response.status} — ${text.slice(0, 500)}`);
    }

    let data: { access_token?: string; expires_in?: number };
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Risposta PDND non valida (non JSON): ${text.slice(0, 200)}`);
    }
    if (!data.access_token) {
      throw new Error(`Risposta PDND priva di access_token: ${text.slice(0, 200)}`);
    }

    const expiresAt = Date.now() + (data.expires_in ?? 600) * 1000;
    this.cache.set(cacheKey, { accessToken: data.access_token, expiresAt });
    this.logger.log(`Voucher DPoP PDND (${env}) ottenuto, valido ${data.expires_in ?? 600}s`);
    return data.access_token;
  }

  /**
   * DPoP proof per la chiamata verso l'erogatore (seconda proof, RFC 9449 §4.3):
   * stessa chiave del proof verso l'authorization server, ma htu/htm della
   * risorsa richiesta e claim `ath` (hash del voucher) a legare la proof a
   * QUESTO specifico access_token.
   */
  async buildResourceDpopProof(env: PdndEnvironment, htm: string, htu: string, accessToken: string): Promise<string> {
    const privateKey = await this.settings.get<string>(`pdnd.${env}.privateKey` as SettingKey);
    if (!privateKey) {
      throw new Error(`Configurazione PDND (${env}) incompleta: manca privateKey`);
    }
    const ath = createHash('sha256').update(accessToken).digest('base64url');
    return this.buildDpopProof(privateKey, htm, htu, { ath });
  }

  /**
   * Firma JWS generica RS256 riusata sia per Agid-JWT-Signature (pattern
   * INTEGRITY_REST_02) sia per Agid-JWT-TrackingEvidence (pattern
   * AUDIT_REST_02) — stessa chiave/kid del client PDND, claim extra
   * (signed_headers, userID/userLocation/LoA...) passati dal chiamante.
   */
  async signAgidJwt(env: PdndEnvironment, aud: string, extraClaims: Record<string, unknown>): Promise<string> {
    const prefix = `pdnd.${env}`;
    const [clientId, kid, privateKey] = await Promise.all([
      this.settings.get<string>(`${prefix}.clientId` as SettingKey),
      this.settings.get<string>(`${prefix}.kid` as SettingKey),
      this.settings.get<string>(`${prefix}.privateKey` as SettingKey),
    ]);

    const missing = Object.entries({ clientId, kid, privateKey })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(`Configurazione PDND (${env}) incompleta: mancano ${missing.join(', ')}`);
    }

    return jwt.sign(
      { iss: clientId, sub: clientId, aud, jti: randomUUID(), ...extraClaims },
      privateKey!,
      { algorithm: 'RS256', keyid: kid!, expiresIn: 60, notBefore: 0 },
    );
  }

  clearCache(env?: PdndEnvironment): void {
    if (env) {
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${env}:`)) this.cache.delete(key);
      }
    } else {
      this.cache.clear();
    }
  }
}
