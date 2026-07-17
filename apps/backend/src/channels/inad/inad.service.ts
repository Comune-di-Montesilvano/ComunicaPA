import { Injectable } from '@nestjs/common';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService, type PdndEnvironment } from '../../pdnd/pdnd-auth.service';

const INAD_BASE_URL = 'https://api.inad.gov.it/rest/inad/v1/domiciliodigitale';
const PRACTICAL_REFERENCE = 'comunicapa-verifica-domicilio';

export interface InadDigitalAddressElement {
  digitalAddress: string;
  practicedProfession?: string;
  usageInfo: { motivation: 'CESSAZIONE_UFFICIO' | 'CESSAZIONE_VOLONTARIA'; dateEndValidity: string };
}

export interface InadExtractResult {
  found: boolean;
  data?: { codiceFiscale: string; since: string; digitalAddress: InadDigitalAddressElement[] };
}

/**
 * Integrazione INAD (Indice Nazionale Domicili Digitali). Solo interrogazione
 * singola per ora (GET /extract/{cf}), sempre in prod, nessuna persistenza —
 * la logica "domicilio eletto = canale unico" è fase successiva.
 */
@Injectable()
export class InadService {
  constructor(
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
  ) {}

  async getVoucher(env: PdndEnvironment): Promise<string> {
    const purposeId = await this.settings.get<string>(`inad.${env}.purposeId` as SettingKey);
    if (!purposeId) {
      throw new Error(`Configurazione INAD (${env}) incompleta: purposeId non impostato`);
    }
    return this.pdndAuth.getVoucher(env, purposeId);
  }

  async extractDigitalAddress(codiceFiscale: string): Promise<InadExtractResult> {
    const voucher = await this.getVoucher('prod');
    const url = `${INAD_BASE_URL}/extract/${encodeURIComponent(codiceFiscale)}?practicalReference=${PRACTICAL_REFERENCE}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${voucher}` } });

    if (response.status === 404) {
      return { found: false };
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`INAD extract fallito: HTTP ${response.status} — ${text.slice(0, 500)}`);
    }
    let data: InadExtractResult['data'];
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Risposta INAD non valida (non JSON): ${text.slice(0, 200)}`);
    }
    return { found: true, data };
  }
}
