import { describe, it, expect, vi } from 'vitest';
import { PosteTrackingController } from './poste-tracking.controller.js';

describe('PosteTrackingController', () => {
  it('delega al servizio e converte la riga in DTO', async () => {
    const svc = {
      startCampaignRun: vi.fn().mockResolvedValue({ total: 3 }),
      getCampaignRun: vi.fn().mockReturnValue({ running: true, total: 3, done: 1 }),
      checkRecipientNow: vi.fn().mockResolvedValue({ status: 'delivered', trackingCode: 'RN000000000IT', checkCount: 2, nextCheckAt: null, lastCheckedAt: new Date('2026-09-24T10:00:00Z'), lastError: null, deliveredAt: new Date('2026-09-04T08:06:00Z'), movements: [] }),
    };
    const ctrl = new PosteTrackingController(svc as any);
    expect(await ctrl.startCampaignRun('c1')).toEqual({ total: 3 });
    expect(ctrl.getCampaignRun('c1')).toMatchObject({ running: true });
    expect(await ctrl.checkRecipient('c1', 'r1')).toMatchObject({ status: 'delivered', maxChecks: 90, deliveredAt: '2026-09-04T08:06:00.000Z' });
    expect(svc.checkRecipientNow).toHaveBeenCalledWith('c1', 'r1');
  });
});
