import { Injectable } from '@nestjs/common';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService, type PdndEnvironment } from '../../pdnd/pdnd-auth.service';

/**
 * Scaffolding per l'integrazione INAD (Indice Nazionale Domicili Digitali).
 * TODO: logica di integrazione da implementare quando saranno disponibili le
 * specifiche INAD e sarà approvata la finalità PDND corrispondente. Non è
 * ancora un canale di invio notifiche — non registrato in CHANNEL_STRATEGIES.
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
}
