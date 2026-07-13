import { Injectable } from '@nestjs/common';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { PdndAuthService, type PdndEnvironment } from '../../pdnd/pdnd-auth.service';

/**
 * Scaffolding per l'integrazione INIPEC. TODO: logica di integrazione da
 * implementare quando saranno disponibili le specifiche INIPEC e sarà
 * approvata la finalità PDND corrispondente. Non è ancora un canale di invio
 * notifiche — non registrato in CHANNEL_STRATEGIES.
 */
@Injectable()
export class InipecService {
  constructor(
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
  ) {}

  async getVoucher(env: PdndEnvironment): Promise<string> {
    const purposeId = await this.settings.get<string>(`inipec.${env}.purposeId` as SettingKey);
    if (!purposeId) {
      throw new Error(`Configurazione INIPEC (${env}) incompleta: purposeId non impostato`);
    }
    return this.pdndAuth.getVoucher(env, purposeId);
  }
}
