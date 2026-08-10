import { ExternalApiService } from './external-api.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import * as fs from 'fs';

jest.mock('fs');

describe('ExternalApiService', () => {
  let service: ExternalApiService;
  let campaigns: {
    create: jest.Mock;
    setExternalClientId: jest.Mock;
    addSingleRecipient: jest.Mock;
    updateDraft: jest.Mock;
    launch: jest.Mock;
  };
  let tokens: { resolve: jest.Mock; markConsumed: jest.Mock };
  let audit: { log: jest.Mock };

  const apiClient = { id: 'client-1', name: 'Comune X' } as any;

  beforeEach(() => {
    campaigns = {
      create: jest.fn().mockResolvedValue({ id: 'camp-1', channelConfig: {} }),
      setExternalClientId: jest.fn().mockResolvedValue(undefined),
      addSingleRecipient: jest.fn().mockResolvedValue({ id: 'rec-1' }),
      updateDraft: jest.fn().mockResolvedValue({ id: 'camp-1' }),
      launch: jest.fn().mockResolvedValue({ launched: 1, campaignId: 'camp-1' }),
    };
    tokens = { resolve: jest.fn(), markConsumed: jest.fn() };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    (fs.mkdirSync as jest.Mock).mockReturnValue(undefined);
    (fs.copyFileSync as jest.Mock).mockReturnValue(undefined);
    service = new ExternalApiService(
      campaigns as unknown as CampaignsService,
      tokens as unknown as ExternalAttachmentTokensService,
      audit as unknown as AuditLogsService,
    );
  });

  it('canale EMAIL senza allegati: crea campagna, recipient, lancia e ritorna QUEUED', async () => {
    const result = await service.createAndLaunch(
      { channelType: 'EMAIL', codiceFiscale: 'RSSMRA80A01H501U', email: 'a@b.it', extraData: {} } as any,
      apiClient,
    );
    expect(campaigns.create).toHaveBeenCalledWith(
      expect.objectContaining({ channelType: 'EMAIL' }),
      'external:Comune X',
    );
    expect(campaigns.setExternalClientId).toHaveBeenCalledWith('camp-1', 'client-1');
    expect(campaigns.addSingleRecipient).toHaveBeenCalledWith('camp-1', expect.objectContaining({ codiceFiscale: 'RSSMRA80A01H501U' }));
    expect(campaigns.launch).toHaveBeenCalledWith('camp-1');
    expect(result).toEqual({ success: true, campaignId: 'camp-1', status: 'QUEUED' });
  });

  it('canale SEND con attachments: risolve i token, copia i file e aggiorna extraData/channelConfig prima del lancio', async () => {
    tokens.resolve.mockReturnValue({ path: '/data/attachments/external-attachments/client-1/tok-1/atto.pdf', filename: 'atto.pdf' });
    await service.createAndLaunch(
      {
        channelType: 'SEND',
        codiceFiscale: 'RSSMRA80A01H501U',
        extraData: {},
        attachments: [{ token: 'tok-1', label: 'Atto' }],
        protocolla: true,
      } as any,
      apiClient,
    );
    expect(tokens.resolve).toHaveBeenCalledWith('client-1', 'tok-1');
    expect(fs.copyFileSync).toHaveBeenCalled();
    expect(tokens.markConsumed).toHaveBeenCalledWith('client-1', 'tok-1');
    expect(campaigns.updateDraft).toHaveBeenCalledWith(
      'camp-1',
      expect.objectContaining({ channelConfig: expect.objectContaining({ attachments: [expect.objectContaining({ key: 'allegato_0', label: 'Atto' })] }) }),
    );
    expect(campaigns.addSingleRecipient).toHaveBeenCalledWith(
      'camp-1',
      expect.objectContaining({ extraData: expect.objectContaining({ allegato_0: '0_atto.pdf' }) }),
    );
  });

  it('secondaryAppIo popolato mappa channelConfig.secondaryChannels in modalità parallel', async () => {
    await service.createAndLaunch(
      { channelType: 'EMAIL', codiceFiscale: 'RSSMRA80A01H501U', email: 'a@b.it', extraData: {}, secondaryAppIo: { subjectOverride: 'oggetto App IO' } } as any,
      apiClient,
    );
    expect(campaigns.create).toHaveBeenCalledWith(
      expect.objectContaining({
        channelConfig: expect.objectContaining({
          secondaryChannels: [{ channel: 'APP_IO', mode: 'parallel', subjectOverride: 'oggetto App IO', bodyOverride: undefined }],
        }),
      }),
      'external:Comune X',
    );
  });

  it('token allegato non risolvibile ritorna errore LAUNCH_BLOCKED senza chiamare launch()', async () => {
    tokens.resolve.mockReturnValue(null);
    const result = await service.createAndLaunch(
      { channelType: 'SEND', codiceFiscale: 'RSSMRA80A01H501U', extraData: {}, attachments: [{ token: 'tok-invalido' }], protocolla: true } as any,
      apiClient,
    );
    expect(result).toEqual({ success: false, error: { code: 'LAUNCH_BLOCKED', message: expect.stringContaining('tok-invalido') } });
    expect(campaigns.launch).not.toHaveBeenCalled();
  });

  it('launch() con blocked:true propaga come LAUNCH_BLOCKED', async () => {
    campaigns.launch.mockResolvedValue({ launched: 0, campaignId: 'camp-1', blocked: true, message: 'Allegato mancante' });
    const result = await service.createAndLaunch(
      { channelType: 'EMAIL', codiceFiscale: 'RSSMRA80A01H501U', email: 'a@b.it', extraData: {} } as any,
      apiClient,
    );
    expect(result).toEqual({ success: false, error: { code: 'LAUNCH_BLOCKED', message: 'Allegato mancante' } });
  });

  it('logga su AuditLogsService con operator "external:<name>" al successo', async () => {
    await service.createAndLaunch(
      { channelType: 'EMAIL', codiceFiscale: 'RSSMRA80A01H501U', email: 'a@b.it', extraData: {} } as any,
      apiClient,
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: 'camp-1', operator: 'external:Comune X', action: 'EXTERNAL_API_CREATE' }),
    );
  });
});
