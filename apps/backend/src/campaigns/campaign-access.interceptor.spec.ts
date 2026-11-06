import { describe, expect, it, vi } from 'vitest';
import { NotFoundException, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { CampaignStatus } from '../entities/campaign.entity.js';
import { CampaignAccessInterceptor } from './campaign-access.interceptor.js';

const ID = '11111111-2222-4333-8444-555555555555';
const BOZZA_ALTRUI = { id: ID, createdBy: 'rossi', signerUsername: 'verdi', status: CampaignStatus.DRAFT, isTest: false };

function setup(found: unknown) {
  const repo = { findOne: vi.fn().mockResolvedValue(found) };
  const interceptor = new CampaignAccessInterceptor(repo as any);
  const next: CallHandler = { handle: vi.fn(() => of('ok')) };
  const run = (path: string, user: unknown, id: string | undefined = ID) => {
    const req = { route: { path }, params: id ? { id } : {}, user };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
    return lastValueFrom(interceptor.intercept(ctx, next) as any);
  };
  return { repo, next, run };
}

const altro = { username: 'bianchi', role: 'user', type: 'operator' };

describe('CampaignAccessInterceptor', () => {
  it.each([
    '/admin/campaigns/:id',
    '/admin/campaigns/:id/stats',
    '/admin/campaigns/:id/signature/unsigned.zip',
    '/admin/campaigns/:id/remote-sign',
    '/admin/campaigns/:id/signature-verification',
    '/admin/campaigns/:id/postal/poste-check',
  ])('%s: bozza altrui → 404, handler non chiamato', async (path) => {
    const { repo, next, run } = setup(BOZZA_ALTRUI);
    await expect(run(path, altro)).rejects.toBeInstanceOf(NotFoundException);
    await expect(run(path, altro)).rejects.toThrow(`Campaign ${ID} not found`);
    expect(next.handle).not.toHaveBeenCalled();
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { id: ID },
      select: { id: true, createdBy: true, signerUsername: true, status: true, isTest: true },
    });
  });

  it.each([
    { nome: 'creatore', user: { username: 'rossi', role: 'user', type: 'operator' } },
    { nome: 'firmatario', user: { username: 'verdi', role: 'user', type: 'operator' } },
    { nome: 'admin', user: { username: 'boss', role: 'admin', type: 'operator' } },
  ])('bozza visibile al $nome → passa', async ({ user }) => {
    const { next, run } = setup(BOZZA_ALTRUI);
    await expect(run('/admin/campaigns/:id/stats', user)).resolves.toBe('ok');
    expect(next.handle).toHaveBeenCalledTimes(1);
  });

  it('invio di prova lanciato, altro user → 404', async () => {
    const { next, run } = setup({ ...BOZZA_ALTRUI, status: CampaignStatus.COMPLETED, isTest: true });
    await expect(run('/admin/campaigns/:id/stats', altro)).rejects.toBeInstanceOf(NotFoundException);
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('campagna non bozza, altro user → passa', async () => {
    const { next, run } = setup({ ...BOZZA_ALTRUI, status: CampaignStatus.RUNNING });
    await expect(run('/admin/campaigns/:id/stats', altro)).resolves.toBe('ok');
    expect(next.handle).toHaveBeenCalledTimes(1);
  });

  it.each(['/admin/campaigns/stats/global', '/admin/campaigns/preview', '/admin/enrichment/jobs/:id', '/admin/campaigns'])(
    '%s → passa senza query DB',
    async (path) => {
      const { repo, next, run } = setup(BOZZA_ALTRUI);
      await expect(run(path, altro)).resolves.toBe('ok');
      expect(repo.findOne).not.toHaveBeenCalled();
      expect(next.handle).toHaveBeenCalledTimes(1);
    },
  );

  it('campagna inesistente → passa (404 dall\'handler)', async () => {
    const { next, run } = setup(null);
    await expect(run('/admin/campaigns/:id/stats', altro)).resolves.toBe('ok');
    expect(next.handle).toHaveBeenCalledTimes(1);
  });

  it('nessun req.user (route pubblica) → passa senza query DB', async () => {
    const { repo, next, run } = setup(BOZZA_ALTRUI);
    await expect(run('/admin/campaigns/:id/stats', undefined)).resolves.toBe('ok');
    expect(repo.findOne).not.toHaveBeenCalled();
    expect(next.handle).toHaveBeenCalledTimes(1);
  });

  it('id non UUID → passa senza query DB (400 da ParseUUIDPipe)', async () => {
    const { repo, next, run } = setup(BOZZA_ALTRUI);
    await expect(run('/admin/campaigns/:id/stats', altro, 'non-uuid')).resolves.toBe('ok');
    expect(repo.findOne).not.toHaveBeenCalled();
    expect(next.handle).toHaveBeenCalledTimes(1);
  });

  it('token cittadino → passa senza query DB', async () => {
    const { repo, next, run } = setup(BOZZA_ALTRUI);
    await expect(run('/admin/campaigns/:id/stats', { sub: 'x', type: 'citizen' })).resolves.toBe('ok');
    expect(repo.findOne).not.toHaveBeenCalled();
    expect(next.handle).toHaveBeenCalledTimes(1);
  });
});
