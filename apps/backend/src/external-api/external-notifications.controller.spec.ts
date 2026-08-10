import { ExternalNotificationsController } from './external-notifications.controller';
import { ExternalApiService } from './external-api.service';
import { CampaignsService } from '../campaigns/campaigns.service';

describe('ExternalNotificationsController', () => {
  let controller: ExternalNotificationsController;
  let externalApi: { createAndLaunch: jest.Mock };
  let campaigns: { findOne: jest.Mock };
  const req = { apiClient: { id: 'client-1', name: 'Comune X' } } as any;

  beforeEach(() => {
    externalApi = { createAndLaunch: jest.fn().mockResolvedValue({ success: true, campaignId: 'camp-1', status: 'QUEUED' }) };
    campaigns = { findOne: jest.fn() };
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

  it('getStatus ritorna lo stato se la campagna appartiene al client chiamante', async () => {
    campaigns.findOne.mockResolvedValue({ id: 'camp-1', externalClientId: 'client-1', status: 'completed', channelType: 'EMAIL' });
    const result = await controller.getStatus('camp-1', req);
    expect(result).toEqual({ success: true, campaignId: 'camp-1', status: 'completed', channelType: 'EMAIL' });
  });
});
