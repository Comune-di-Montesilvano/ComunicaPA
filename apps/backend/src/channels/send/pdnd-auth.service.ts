import { Injectable, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';

export type SendEnvironment = 'test' | 'prod';

interface CachedVoucher {
  accessToken: string;
  expiresAt: number;
}

@Injectable()
export class PdndAuthService {
  private readonly logger = new Logger(PdndAuthService.name);
  private readonly cache = new Map<SendEnvironment, CachedVoucher>();

  constructor(private readonly settings: AppSettingsService) {}

  /** Restituisce un voucher PDND valido, riusando la cache se non scaduto (margine 5s). */
  async getVoucher(env: SendEnvironment, forceRefresh = false): Promise<string> {
    const cached = this.cache.get(env);
    if (!forceRefresh && cached && cached.expiresAt > Date.now() + 5_000) {
      return cached.accessToken;
    }

    const prefix = `send.${env}`;
    const [tokenUrl, audience, clientId, kid, purposeId, privateKey] = await Promise.all([
      this.settings.get<string>(`${prefix}.pdndTokenUrl` as SettingKey),
      this.settings.get<string>(`${prefix}.pdndAudience` as SettingKey),
      this.settings.get<string>(`${prefix}.pdndClientId` as SettingKey),
      this.settings.get<string>(`${prefix}.pdndKid` as SettingKey),
      this.settings.get<string>(`${prefix}.pdndPurposeId` as SettingKey),
      this.settings.get<string>(`${prefix}.pdndPrivateKey` as SettingKey),
    ]);

    const missing = Object.entries({ tokenUrl, audience, clientId, kid, purposeId, privateKey })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(`Configurazione SEND (${env}) incompleta: mancano ${missing.join(', ')}`);
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
    this.cache.set(env, { accessToken: data.access_token, expiresAt });
    this.logger.log(`Voucher PDND (${env}) ottenuto, valido ${data.expires_in ?? 600}s`);
    return data.access_token;
  }

  clearCache(env?: SendEnvironment): void {
    if (env) this.cache.delete(env);
    else this.cache.clear();
  }
}
