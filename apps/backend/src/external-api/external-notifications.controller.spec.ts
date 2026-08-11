import { ExternalNotificationsController } from './external-notifications.controller';
import { ExternalApiService } from './external-api.service';
import { CampaignsService } from '../campaigns/campaigns.service';

describe('ExternalNotificationsController', () => {
  let controller: ExternalNotificationsController;
  let externalApi: { createAndLaunch: jest.Mock };
  let campaigns: { findOne: jest.Mock; getExternalDeliveryStatus: jest.Mock };
  const req = { apiClient: { id: 'client-1', name: 'Comune X' } } as any;

  beforeEach(() => {
    externalApi = { createAndLaunch: jest.fn().mockResolvedValue({ success: true, campaignId: 'camp-1', status: 'QUEUED' }) };
    campaigns = { findOne: jest.fn(), getExternalDeliveryStatus: jest.fn().mockResolvedValue(null) };
    controller = new ExternalNotificationsController(
      externalApi as unknown as ExternalApiService,
      campaigns as unknown as CampaignsService,
    );
  });

  it('create delega a ExternalApiService.createAndLaunch con l\'apiClient della richiesta', async () => {
    const dto = { channelType: 'EMAIL', codiceFiscale: 'RSSMRA80A01H501U', email: 'a@b.it', extraData: {} } as any;
    const result = await controller.create(dto, req);
    expect(externalApi.createAndLaunch).toHaveBeenCalledWith(dto, req.apiClient);
    expect(result).toEqual({ success: true, campaignId: 'camp-1', status: 'QUEUED' });
  });

  it('getStatus ritorna NOT_FOUND se la campagna non appartiene al client chiamante', async () => {
    campaigns.findOne.mockResolvedValue({ id: 'camp-1', externalClientId: 'altro-client', status: 'queued' });
    const result = await controller.getStatus('camp-1', req);
    expect(result).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'Notifica non trovata' } });
  });

  it('getStatus ritorna lo stesso NOT_FOUND se la campagna non esiste affatto (findOne rigetta)', async () => {
    campaigns.findOne.mockRejectedValue(new Error('Campaign camp-inesistente not found'));
    const result = await controller.getStatus('camp-inesistente', req);
    expect(result).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'Notifica non trovata' } });
  });

  it('getStatus ritorna lo stato se la campagna appartiene al client chiamante, delivery=null se nessun attempt ancora', async () => {
    campaigns.findOne.mockResolvedValue({ id: 'camp-1', externalClientId: 'client-1', status: 'completed', channelType: 'EMAIL' });
    campaigns.getExternalDeliveryStatus.mockResolvedValue(null);
    const result = await controller.getStatus('camp-1', req);
    expect(result).toEqual({ success: true, campaignId: 'camp-1', status: 'completed', channelType: 'EMAIL', delivery: null });
  });

  it('getStatus include delivery.sendStatus per una campagna SEND con attempt', async () => {
    campaigns.findOne.mockResolvedValue({ id: 'camp-2', externalClientId: 'client-1', status: 'queued', channelType: 'SEND' });
    campaigns.getExternalDeliveryStatus.mockResolvedValue({ attemptStatus: 'success', sendStatus: 'DELIVERED', error: null });
    const result = await controller.getStatus('camp-2', req);
    expect(result).toEqual({
      success: true,
      campaignId: 'camp-2',
      status: 'queued',
      channelType: 'SEND',
      delivery: { attemptStatus: 'success', sendStatus: 'DELIVERED', error: null },
    });
  });

  it('getStatus include delivery.postalStatus per una campagna POSTAL con attempt', async () => {
    campaigns.findOne.mockResolvedValue({ id: 'camp-3', externalClientId: 'client-1', status: 'completed', channelType: 'POSTAL' });
    campaigns.getExternalDeliveryStatus.mockResolvedValue({ attemptStatus: 'success', postalStatus: 'Confermato', error: null });
    const result = await controller.getStatus('camp-3', req);
    expect(result.delivery).toEqual({ attemptStatus: 'success', postalStatus: 'Confermato', error: null });
  });
});
