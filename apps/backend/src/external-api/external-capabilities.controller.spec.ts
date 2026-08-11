import { ExternalCapabilitiesController } from './external-capabilities.controller';
import { MailConfigsService } from '../mail-configs/mail-configs.service';
import { IoServicesService } from '../io-services/io-services.service';
import { PostalProvidersService } from '../postal-providers/postal-providers.service';
import { AppSettingsService } from '../settings/app-settings.service';

describe('ExternalCapabilitiesController', () => {
  let controller: ExternalCapabilitiesController;
  let mailConfigs: { listMasked: jest.Mock };
  let ioServices: { resolveApiKey: jest.Mock };
  let postalProviders: { getActive: jest.Mock };
  let settings: { get: jest.Mock };

  beforeEach(() => {
    mailConfigs = {
      listMasked: jest.fn().mockResolvedValue([
        { type: 'EMAIL', active: true },
        { type: 'PEC', active: false },
      ]),
    };
    ioServices = { resolveApiKey: jest.fn().mockResolvedValue(null) };
    postalProviders = { getActive: jest.fn().mockResolvedValue(null) };
    settings = {
      get: jest.fn(async (key: string) => {
        if (key === 'send.enabledTaxonomyCodes') return '["TARI","SANZIONI"]';
        if (key === 'send.environment') return 'collaudo';
        if (key === 'send.test.group') return 'gruppo-1';
        return '';
      }),
    };
    controller = new ExternalCapabilitiesController(
      mailConfigs as unknown as MailConfigsService,
      ioServices as unknown as IoServicesService,
      postalProviders as unknown as PostalProvidersService,
      settings as unknown as AppSettingsService,
    );
  });

  it('EMAIL attivo, PEC non attivo, riflette listMasked()', async () => {
    const result = await controller.get();
    expect(result.channels.EMAIL).toEqual({ active: true });
    expect(result.channels.PEC).toEqual({ active: false });
  });

  it('APP_IO e appIoSecondary non attivi se resolveApiKey ritorna null', async () => {
    const result = await controller.get();
    expect(result.channels.APP_IO).toEqual({ active: false });
    expect(result.appIoSecondary).toEqual({ available: false });
  });

  it('APP_IO attivo se resolveApiKey ritorna una chiave', async () => {
    ioServices.resolveApiKey.mockResolvedValue({ apiKey: 'k', idService: 's1' });
    const result = await controller.get();
    expect(result.channels.APP_IO).toEqual({ active: true });
    expect(result.appIoSecondary).toEqual({ available: true });
  });

  it('SEND riflette enabledTaxonomyCodes e requiresGroup', async () => {
    const result = await controller.get();
    expect(result.channels.SEND).toEqual({ active: true, enabledTaxonomyCodes: ['TARI', 'SANZIONI'], requiresGroup: true });
  });

  it('POSTAL non attivo se nessun provider attivo', async () => {
    const result = await controller.get();
    expect(result.channels.POSTAL).toEqual({ active: false, enabledServiceTypes: [], contratti: [] });
  });

  it('POSTAL attivo riflette enabledServiceTypes/contratti del provider attivo', async () => {
    postalProviders.getActive.mockResolvedValue({ enabledServiceTypes: ['Raccomandata1Market'], contratti: [{ codiceContratto: 'C1', descrizione: 'd', tipologia: 't', estero: false }] });
    const result = await controller.get();
    expect(result.channels.POSTAL).toEqual({
      active: true,
      enabledServiceTypes: ['Raccomandata1Market'],
      contratti: [{ codiceContratto: 'C1', descrizione: 'd', tipologia: 't', estero: false }],
    });
  });
});
