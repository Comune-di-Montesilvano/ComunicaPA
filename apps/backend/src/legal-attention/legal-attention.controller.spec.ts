// apps/backend/src/legal-attention/legal-attention.controller.spec.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { LegalAttentionController } from './legal-attention.controller.js';
import { LegalAttentionService } from './legal-attention.service.js';

describe('LegalAttentionController', () => {
  let controller: LegalAttentionController;
  const svc = { getSummary: vi.fn(), getCampaignItems: vi.fn(), applyReviews: vi.fn() };
  const req = { user: { sub: 'x', username: 'mrossi', role: 'user', type: 'operator' } } as any;

  beforeEach(async () => {
    Object.values(svc).forEach((f) => f.mockReset());
    const module = await Test.createTestingModule({
      controllers: [LegalAttentionController],
      providers: [{ provide: LegalAttentionService, useValue: svc }],
    }).compile();
    controller = module.get(LegalAttentionController);
  });

  it('summary delega con utente', async () => {
    svc.getSummary.mockResolvedValueOnce({ items: [] });
    await expect(controller.getSummary(req)).resolves.toEqual({ items: [] });
    expect(svc.getSummary).toHaveBeenCalledWith({ username: 'mrossi', role: 'user' });
  });

  it('campaign items: page/pageSize numerici con default', async () => {
    svc.getCampaignItems.mockResolvedValueOnce({ items: [], total: 0 });
    await controller.getCampaignItems('c1', undefined, undefined, req);
    expect(svc.getCampaignItems).toHaveBeenCalledWith('c1', { username: 'mrossi', role: 'user' }, 1, 50);
    await controller.getCampaignItems('c1', '3', '20', req);
    expect(svc.getCampaignItems).toHaveBeenLastCalledWith('c1', { username: 'mrossi', role: 'user' }, 3, 20);
  });

  it('reviews delega il body', async () => {
    svc.applyReviews.mockResolvedValueOnce({ applied: 1, skipped: [] });
    const dto = { recipientIds: ['r1'], action: 'ack' as const };
    await expect(controller.applyReviews(dto, req)).resolves.toEqual({ applied: 1, skipped: [] });
    expect(svc.applyReviews).toHaveBeenCalledWith(dto, { username: 'mrossi', role: 'user' });
  });
});
