import { Injectable } from '@nestjs/common';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService, type PdndEnvironment } from '../../pdnd/pdnd-auth.service';
import { RegistroImpreseRateLimitError } from './registro-imprese-rate-limit.error';

const REGISTRO_IMPRESE_BASE_URL: Record<PdndEnvironment, string> = {
  test: 'https://pdndcl.registroimprese.it',
  prod: 'https://pdnd.registroimprese.it',
};

export interface RegistroImpreseDettaglioResult {
  found: boolean;
  raw: string;
  pec?: string;
  denominazione?: string;
}

/**
 * Integrazione Registro Imprese (PCAD-PDND, Unioncamere) — sostituisce
 * INIPEC come fonte del domicilio digitale d'impresa. Risposta XML opaca
 * (nessuno schema nello spec OpenAPI, solo {type:"string"}): parsing
 * minimale finché non disponibile un esempio reale (API non ancora
 * abilitata per l'ente al momento di questa implementazione — vedi
 * docs/superpowers/specs/2026-08-11-registro-imprese-pdnd-design.md).
 */
@Injectable()
export class RegistroImpreseService {
  constructor(
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
  ) {}

  async getVoucher(env: PdndEnvironment): Promise<string> {
    const purposeId = await this.settings.get<string>(`registroImprese.${env}.purposeId` as SettingKey);
    if (!purposeId) {
      throw new Error(`Configurazione Registro Imprese (${env}) incompleta: purposeId non impostato`);
    }
    return this.pdndAuth.getVoucher(env, purposeId);
  }

  async dettaglioImpresa(partitaIva: string, env: PdndEnvironment = 'prod'): Promise<RegistroImpreseDettaglioResult> {
    const voucher = await this.getVoucher(env);
    const url = `${REGISTRO_IMPRESE_BASE_URL[env]}/rest/pcad/v1/dettaglio/codicefiscale?codiceFiscale=${encodeURIComponent(partitaIva)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${voucher}` } });
    const text = await response.text();

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
      throw new RegistroImpreseRateLimitError(retryAfterSeconds);
    }
    if (response.status === 404) {
      return { found: false, raw: text };
    }
    if (!response.ok) {
      throw new Error(`Registro Imprese dettaglio fallito: HTTP ${response.status} — ${text.slice(0, 500)}`);
    }

    // Fase 1: schema XML non documentato nello spec OpenAPI. Nessun parsing
    // tipizzato finché non arriva un esempio reale — solo `raw` restituito.
    // pec/denominazione da estrarre qui una volta noto lo schema.
    return { found: true, raw: text };
  }
}
