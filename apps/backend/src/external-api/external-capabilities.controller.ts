import { Controller, Get, UseFilters, UseGuards } from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ExternalApiExceptionFilter } from './external-api-exception.filter';
import { MailConfigsService } from '../mail-configs/mail-configs.service';
import { IoServicesService } from '../io-services/io-services.service';
import { PostalProvidersService } from '../postal-providers/postal-providers.service';
import { AppSettingsService } from '../settings/app-settings.service';

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
    const sendGroup = await this.settings.get<string>(
      sendEnv === 'produzione' ? 'send.prod.group' : 'send.test.group',
    );
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
        SEND: { active: enabledTaxonomyCodes.length > 0, enabledTaxonomyCodes, requiresGroup: !!sendGroup },
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
