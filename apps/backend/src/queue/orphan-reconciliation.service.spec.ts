import { OrphanReconciliationService } from './orphan-reconciliation.service.js';

function buildQueryBuilder(rawRows: unknown[]) {
  const qb: any = {
    innerJoin: () => qb,
    where: () => qb,
    andWhere: () => qb,
    select: () => qb,
    getRawMany: async () => rawRows,
  };
  return qb;
}

function buildService(rawRows: unknown[], getJob: jest.Mock, addBulk: jest.Mock) {
  const attemptRepo: any = { createQueryBuilder: () => buildQueryBuilder(rawRows) };
  const notificationQueues: any = { getJob, addBulk };
  return new OrphanReconciliationService(attemptRepo, notificationQueues);
}

describe('OrphanReconciliationService', () => {
  const baseRow = {
    attemptId: 'att-1',
    recipientId: 'rec-1',
    channelType: 'PEC',
    campaignId: 'camp-1',
    campaignChannelType: 'PEC',
    protocolla: null,
  };

  it('ri-accoda un attempt queued il cui job è assente dalla coda del motore giusto', async () => {
    const getJob = jest.fn().mockResolvedValue(undefined);
    const addBulk = jest.fn().mockResolvedValue(undefined);
    const service = buildService([baseRow], getJob, addBulk);

    const result = await service.reconcileEngine('PEC');

    expect(getJob).toHaveBeenCalledWith('PEC', 'att-1');
    expect(addBulk).toHaveBeenCalledWith('PEC', [
      {
        name: 'send',
        data: { campaignId: 'camp-1', recipientId: 'rec-1', attemptId: 'att-1', channel: 'PEC' },
        opts: { jobId: 'att-1' },
      },
    ]);
    expect(result).toEqual({ checked: 1, repaired: 1 });
  });

  it('non tocca un attempt il cui job esiste ancora in coda', async () => {
    const getJob = jest.fn().mockResolvedValue({ id: 'att-1' });
    const addBulk = jest.fn();
    const service = buildService([baseRow], getJob, addBulk);

    const result = await service.reconcileEngine('PEC');

    expect(addBulk).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, repaired: 0 });
  });

  it('instrada un attempt dirottato (channelType diverso dal canale campagna) sulla coda del motore calcolato dalla campagna, non da attempt.channelType', async () => {
    // Campagna EMAIL, destinatario dirottato da INAD a PEC: attempt.channelType='PEC'
    // ma senza protocollazione l'engine di invio resta quello della campagna (EMAIL).
    const divertedRow = { ...baseRow, channelType: 'PEC', campaignChannelType: 'EMAIL', protocolla: null };
    const getJob = jest.fn().mockResolvedValue(undefined);
    const addBulk = jest.fn().mockResolvedValue(undefined);
    const service = buildService([divertedRow], getJob, addBulk);

    const result = await service.reconcileEngine('EMAIL');

    expect(getJob).toHaveBeenCalledWith('EMAIL', 'att-1');
    expect(addBulk).toHaveBeenCalledWith('EMAIL', [
      expect.objectContaining({ data: expect.objectContaining({ channel: 'PEC' }) }),
    ]);
    expect(result).toEqual({ checked: 1, repaired: 1 });
  });

  it('instrada su PROTOCOLLAZIONE una campagna SEND, o una campagna qualunque con protocolla=true', async () => {
    const sendRow = { ...baseRow, campaignChannelType: 'SEND', protocolla: null };
    const getJob = jest.fn().mockResolvedValue(undefined);
    const addBulk = jest.fn().mockResolvedValue(undefined);
    const service = buildService([sendRow], getJob, addBulk);

    await service.reconcileEngine('PROTOCOLLAZIONE');

    expect(getJob).toHaveBeenCalledWith('PROTOCOLLAZIONE', 'att-1');
    expect(addBulk).toHaveBeenCalledWith('PROTOCOLLAZIONE', expect.any(Array));
  });

  it('reconcileEngine su un motore senza candidati non chiama né getJob né addBulk', async () => {
    const getJob = jest.fn();
    const addBulk = jest.fn();
    const service = buildService([baseRow], getJob, addBulk); // row è PEC

    const result = await service.reconcileEngine('EMAIL');

    expect(getJob).not.toHaveBeenCalled();
    expect(addBulk).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 0, repaired: 0 });
  });

  it('reconcileAll ripara ogni motore indipendentemente e riporta i conteggi per motore', async () => {
    const rows = [
      { ...baseRow, attemptId: 'att-pec', channelType: 'PEC', campaignChannelType: 'PEC' },
      { ...baseRow, attemptId: 'att-email', channelType: 'EMAIL', campaignChannelType: 'EMAIL', recipientId: 'rec-2' },
    ];
    const getJob = jest.fn().mockResolvedValue(undefined);
    const addBulk = jest.fn().mockResolvedValue(undefined);
    const service = buildService(rows, getJob, addBulk);

    const result = await service.reconcileAll();

    expect(result.PEC).toEqual({ checked: 1, repaired: 1 });
    expect(result.EMAIL).toEqual({ checked: 1, repaired: 1 });
    expect(result.APP_IO).toEqual({ checked: 0, repaired: 0 });
    expect(result.POSTAL).toEqual({ checked: 0, repaired: 0 });
    expect(result.PROTOCOLLAZIONE).toEqual({ checked: 0, repaired: 0 });
  });

  it('accoda in chunk da 500', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ ...baseRow, attemptId: `att-${i}`, recipientId: `rec-${i}` }));
    const getJob = jest.fn().mockResolvedValue(undefined);
    const addBulk = jest.fn().mockResolvedValue(undefined);
    const service = buildService(rows, getJob, addBulk);

    const result = await service.reconcileEngine('PEC');

    expect(addBulk).toHaveBeenCalledTimes(2);
    expect(addBulk.mock.calls[0][1]).toHaveLength(500);
    expect(addBulk.mock.calls[1][1]).toHaveLength(1);
    expect(result).toEqual({ checked: 501, repaired: 501 });
  });
});
