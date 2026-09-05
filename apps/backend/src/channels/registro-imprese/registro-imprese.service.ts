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
 * INIPEC come fonte del domicilio digitale d'impresa. Risposta XML (nessuno
 * schema nello spec OpenAPI, solo {type:"string"}) — parsing via regex,
 * struttura confermata con chiamata reale (vedi parseDettaglioImpresaXml
 * sotto e docs/superpowers/specs/2026-08-11-registro-imprese-pdnd-design.md).
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

    const { pec, denominazione } = parseDettaglioImpresaXml(text);
    return { found: true, raw: text, pec, denominazione };
  }
}

/**
 * Parsing minimale via regex (nessuna dipendenza XML aggiunta apposta per
 * questo, vedi CLAUDE.md "pnpm v11" per il costo di una nuova dependency in
 * Docker) — struttura confermata con una chiamata reale del 2026-09-05
 * (endpoint appena abilitato per l'ente, PIVA reale, encoding windows-1252):
 *
 *   <blocchi-impresa><dati-identificativi ... denominazione="ACME SRL" ...>
 *     <indirizzo-posta-certificata>PEC@ESEMPIO.IT</indirizzo-posta-certificata>
 *   </dati-identificativi>...
 *
 * Solo il PRIMO blocco `dati-identificativi` (sede impresa) va letto — blocchi
 * successivi (persone, localizzazioni) non hanno mai `indirizzo-posta-certificata`
 * a questo livello, ma un match globale prenderebbe comunque solo il primo per
 * via del flag non-globale sulle regex sotto.
 */
function parseDettaglioImpresaXml(xml: string): { pec?: string; denominazione?: string } {
  const denominazioneMatch = /<dati-identificativi\b[^>]*\bdenominazione="([^"]*)"/.exec(xml);
  const pecMatch = /<indirizzo-posta-certificata>([^<]*)<\/indirizzo-posta-certificata>/.exec(xml);
  return {
    denominazione: denominazioneMatch?.[1]?.trim() || undefined,
    pec: pecMatch?.[1]?.trim().toLowerCase() || undefined,
  };
}
