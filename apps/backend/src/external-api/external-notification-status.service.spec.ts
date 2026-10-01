import { ExternalNotificationStatusService } from './external-notification-status.service.js';

const REC_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';

function setup(opts: { recipient?: unknown; campaign?: unknown; attempts?: unknown[]; poste?: unknown } = {}) {
  const recipientRepo = { findOne: jest.fn(async () => opts.recipient ?? null) };
  const campaignRepo = { findOneBy: jest.fn(async () => opts.campaign ?? null) };
  const attemptRepo = { find: jest.fn(async () => opts.attempts ?? []) };
  const posteRepo = { findOne: jest.fn(async () => opts.poste ?? null) };
  const svc = new ExternalNotificationStatusService(recipientRepo as any, campaignRepo as any, attemptRepo as any, posteRepo as any);
  return { svc, recipientRepo, attemptRepo, posteRepo };
}

const recipient = { id: REC_ID, campaignId: 'camp-1', createdAt: new Date('2026-10-01T10:00:00Z'), status: 'sent', codiceFiscale: 'RSSMRA80A01H501U', inadCheck: null };

describe('ExternalNotificationStatusService.get', () => {
  it('id non UUID → NOT_FOUND senza query', async () => {
    const { svc, recipientRepo } = setup();
    await expect(svc.get('../x', 'client-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(recipientRepo.findOne).not.toHaveBeenCalled();
  });

  it('destinatario di un altro client → stesso NOT_FOUND', async () => {
    const { svc } = setup({ recipient, campaign: { id: 'camp-1', externalClientId: 'altro', status: 'completed', channelType: 'EMAIL', channelConfig: {} } });
    await expect(svc.get(REC_ID, 'client-1')).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Notifica non trovata' });
  });

  it('usa l\'attempt con attemptNumber più alto e la verifica Poste di quell\'attempt', async () => {
    const { svc, posteRepo } = setup({
      recipient,
      campaign: { id: 'camp-1', externalClientId: 'client-1', status: 'completed', channelType: 'EMAIL', channelConfig: {} },
      attempts: [
        { id: 'a1', attemptNumber: 1, status: 'failed', channelType: 'EMAIL', sentAt: null, errorMessage: 'x' },
        { id: 'a2', attemptNumber: 2, status: 'success', channelType: 'EMAIL', sentAt: new Date('2026-10-01T10:05:00Z') },
      ],
    });
    const s = await svc.get(REC_ID, 'client-1');
    expect(s.status).toBe('sent');
    expect(posteRepo.findOne).toHaveBeenCalledWith({ where: { attemptId: 'a2' } });
  });
});
