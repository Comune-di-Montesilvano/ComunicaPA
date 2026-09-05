import { Controller, Get, UseFilters, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator.js';
import { ApiKeyGuard } from './guards/api-key.guard.js';
import { ExternalApiExceptionFilter } from './external-api-exception.filter.js';
import { MailConfigsService } from '../mail-configs/mail-configs.service.js';
import { IoServicesService } from '../io-services/io-services.service.js';
import { PostalProvidersService } from '../postal-providers/postal-providers.service.js';
import { AppSettingsService } from '../settings/app-settings.service.js';
import type { SettingKey } from '../settings/settings.registry.js';

@Controller('external/v1/capabilities')
@Public()
@UseGuards(ApiKeyGuard)
@UseFilters(ExternalApiExceptionFilter)
export class ExternalCapabilitiesController {
  constructor(
    private readonly mailConfigs: MailConfigsService,
    private readonly ioServices: IoServicesService,
    private readonly postalProviders: PostalProvidersService,
    private readonly settings: AppSettingsService,
  ) {}

  @Get()
  async get() {
    const [mailList, appIoKey, postalActive, taxonomyRaw, sendEnv] = await Promise.all([
      this.mailConfigs.listMasked(),
      this.ioServices.resolveApiKey(),
      this.postalProviders.getActive(),
      this.settings.get<string>('send.enabledTaxonomyCodes'),
      this.settings.get<string>('send.environment'),
    ]);

    const emailActive = mailList.some((c) => c.type === 'EMAIL' && c.active);
    const pecActive = mailList.some((c) => c.type === 'PEC' && c.active);
    const appIoActive = appIoKey !== null;

    // Stesso ambiente/prefisso risolto da SendDispatchService.dispatchOne():
    // "active" deve riflettere se SEND è davvero utilizzabile (credenziali
    // PDND configurate per l'ambiente attivo), non un segnale indiretto come
    // la lunghezza della taxonomy allow-list — una campagna SEND configurata
    // ma con taxonomy vuota è comunque "attiva" (nessun vincolo di codici
    // abilitati), mentre una con taxonomy popolata ma senza apiKey/purposeId
    // non può davvero inviare nulla.
    const envKey = sendEnv === 'produzione' ? 'prod' : 'test';
    const prefix = `send.${envKey}`;
    const [sendApiKey, sendPurposeId, sendGroup] = await Promise.all([
      this.settings.get<string>(`${prefix}.apiKey` as SettingKey),
      this.settings.get<string>(`${prefix}.purposeId` as SettingKey),
      this.settings.get<string>(`${prefix}.group` as SettingKey),
    ]);
    const sendActive = !!sendApiKey && !!sendPurposeId;

    let enabledTaxonomyCodes: string[] = [];
    try {
      enabledTaxonomyCodes = JSON.parse(taxonomyRaw || '[]');
    } catch {
      enabledTaxonomyCodes = [];
    }

    return {
      success: true,
      channels: {
        EMAIL: { active: emailActive },
        PEC: { active: pecActive },
        APP_IO: { active: appIoActive },
        SEND: { active: sendActive, enabledTaxonomyCodes, requiresGroup: !!sendGroup },
        POSTAL: {
          active: postalActive !== null,
          enabledServiceTypes: postalActive?.enabledServiceTypes ?? [],
          contratti: postalActive?.contratti ?? [],
        },
      },
      appIoSecondary: { available: appIoActive },
    };
  }
}
