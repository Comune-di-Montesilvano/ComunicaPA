import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { PostePostalTrackingService, MAX_POSTE_CHECKS } from './poste-postal-tracking.service.js';
import { PosteTrackingError } from './poste-tracking-mapping.util.js';
import type { PostalPosteTracking } from '../../../entities/postal-poste-tracking.entity.js';

const DELIVERED = { esitoRicerca: '3', stato: '5', flagRitorno: false, tipoProdotto: 'RACC', movements: [{ at: '2026-09-04T08:06:00.000Z', luogo: 'SVIZZERA', statoLavorazione: 'con successo in data', box: '5', flagRitorno: false }], raw: {} };
const NOT_FOUND = { esitoRicerca: '1', stato: '1', flagRitorno: false, tipoProdotto: null, movements: [], raw: {} };

function row(partial: Partial<PostalPosteTracking> = {}): PostalPosteTracking {
  return { id: 't1', attemptId: 'a1', trackingCode: 'RN000000000IT', status: 'pending', checkCount: 0, nextCheckAt: new Date(), lastCheckedAt: null, lastError: null, posteStato: null, posteEsitoRicerca: null, posteProduct: null, deliveredAt: null, movements: null, lastResponse: null, createdAt: new Date(), updatedAt: new Date(), ...partial } as PostalPosteTracking;
}

function makeQb(rows: PostalPosteTracking[]) {
  const qb: any = {};
  for (const m of ['innerJoin', 'where', 'andWhere', 'orderBy']) qb[m] = vi.fn().mockReturnValue(qb);
  qb.getMany = vi.fn().mockResolvedValue(rows);
  return qb;
}

function whereSql(qb: any): string {
  return [qb.where, qb.andWhere].flatMap((f: any) => f.mock.calls.map((c: any[]) => c[0])).join(' ');
}

describe('PostePostalTrackingService', () => {
  let service: PostePostalTrackingService;
  let repo: any;
  let attemptRepo: any;
  let recipientRepo: any;
  let client: { track: ReturnType<typeof vi.fn> };
  let settings: { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    repo = {
      query: vi.fn().mockResolvedValue([]),
      save: vi.fn(async (r) => r),
      create: vi.fn((r) => ({ ...row(), ...r })),
      findOneBy: vi.fn().mockResolvedValue(null),
      createQueryBuilder: vi.fn(),
    };
    attemptRepo = { findOne: vi.fn() };
    recipientRepo = { findOne: vi.fn() };
    client = { track: vi.fn() };
    settings = { get: vi.fn().mockResolvedValue(true) };
    service = new PostePostalTrackingService(repo, attemptRepo, recipientRepo, client as any, settings as any);
    (service as any).sleep = vi.fn().mockResolvedValue(undefined);
  });

  describe('backfill', () => {
    it('INSERT idempotente solo su ultimo attempt NonConsegnato con codice', async () => {
      repo.query.mockResolvedValue([{ id: 'x' }, { id: 'y' }]);
      expect(await service.backfill()).toBe(2);
      const sql = repo.query.mock.calls[0][0] as string;
      expect(sql).toContain('ON CONFLICT (attempt_id) DO NOTHING');
      expect(sql).toContain("na.postal_status = 'NonConsegnato'");
      expect(sql).toContain('newer.attempt_number > na.attempt_number');
      expect(repo.query.mock.calls[0][1]).toEqual([]);
    });

    it('ristretto alla campagna quando passato', async () => {
      await service.backfill('c1');
      expect(repo.query.mock.calls[0][0]).toContain('r.campaign_id = $1');
      expect(repo.query.mock.calls[0][1]).toEqual(['c1']);
    });
  });

  describe('checkOne (cron)', () => {
    it('delivered: finale, data consegna, check_count++', async () => {
      client.track.mockResolvedValue(DELIVERED);
      const r = row();
      expect(await service.checkOne(r, 'cron')).toBe('delivered');
      expect(r.status).toBe('delivered');
      expect(r.checkCount).toBe(1);
      expect(r.nextCheckAt).toBeNull();
      expect(r.deliveredAt?.toISOString()).toBe('2026-09-04T08:06:00.000Z');
      expect(r.posteStato).toBe('5');
      expect(r.lastCheckedAt).toBeInstanceOf(Date);
      expect(repo.save).toHaveBeenCalledWith(r);
    });

    it('pending: resta pending, prossimo controllo tra un giorno', async () => {
      client.track.mockResolvedValue(NOT_FOUND);
      const r = row({ checkCount: 3 });
      const before = Date.now();
      expect(await service.checkOne(r, 'cron')).toBe('pending');
      expect(r.checkCount).toBe(4);
      expect(r.nextCheckAt!.getTime()).toBeGreaterThanOrEqual(before + 86_400_000 - 1000);
    });

    it(`al ${MAX_POSTE_CHECKS}° controllo senza esito → gave_up`, async () => {
      client.track.mockResolvedValue(NOT_FOUND);
      const r = row({ checkCount: MAX_POSTE_CHECKS - 1 });
      expect(await service.checkOne(r, 'cron')).toBe('gave_up');
      expect(r.checkCount).toBe(MAX_POSTE_CHECKS);
      expect(r.nextCheckAt).toBeNull();
    });

    it('errore: non consuma controllo, aggiorna last_checked_at e last_error', async () => {
      client.track.mockRejectedValue(new PosteTrackingError('HTTP 503 da Poste', 'http'));
      const r = row({ checkCount: 5 });
      expect(await service.checkOne(r, 'cron')).toBe('error');
      expect(r.checkCount).toBe(5);
      expect(r.status).toBe('pending');
      expect(r.lastError).toBe('HTTP 503 da Poste');
      expect(r.lastCheckedAt).toBeInstanceOf(Date);
      expect(repo.save).toHaveBeenCalledWith(r);
    });
  });

  describe('checkOne (manual)', () => {
    it('non incrementa check_count e non sposta next_check_at', async () => {
      client.track.mockResolvedValue(NOT_FOUND);
      const next = new Date('2030-01-01T00:00:00Z');
      const r = row({ checkCount: 7, nextCheckAt: next });
      expect(await service.checkOne(r, 'manual')).toBe('pending');
      expect(r.checkCount).toBe(7);
      expect(r.nextCheckAt).toBe(next);
    });

    it('su gave_up senza esito resta gave_up', async () => {
      client.track.mockResolvedValue(NOT_FOUND);
      const r = row({ status: 'gave_up', checkCount: 90, nextCheckAt: null });
      expect(await service.checkOne(r, 'manual')).toBe('gave_up');
      expect(r.status).toBe('gave_up');
    });

    it('su gave_up con consegna → delivered', async () => {
      client.track.mockResolvedValue(DELIVERED);
      const r = row({ status: 'gave_up', checkCount: 90, nextCheckAt: null });
      expect(await service.checkOne(r, 'manual')).toBe('delivered');
    });
  });

  describe('handleCron', () => {
    it('kill-switch: nessuna chiamata se disattivato', async () => {
      settings.get.mockResolvedValue(false);
      await service.handleCron();
      expect(repo.query).not.toHaveBeenCalled();
      expect(client.track).not.toHaveBeenCalled();
    });

    it('backfill poi controllo sequenziale dei dovuti, solo NonConsegnato', async () => {
      const qb = makeQb([row({ id: 't1' }), row({ id: 't2' })]);
      repo.createQueryBuilder.mockReturnValue(qb);
      client.track.mockResolvedValue(NOT_FOUND);
      await service.handleCron();
      expect(repo.query).toHaveBeenCalledTimes(1);
      expect(client.track).toHaveBeenCalledTimes(2);
      const where = whereSql(qb);
      expect(where).toContain("a.postal_status = 'NonConsegnato'");
      expect(where).toContain('t.next_check_at <= now()');
      expect((service as any).sleep).toHaveBeenCalledTimes(1);
    });

    it('circuit breaker: si ferma dopo 5 errori consecutivi', async () => {
      const rows = Array.from({ length: 8 }, (_, i) => row({ id: `t${i}` }));
      repo.createQueryBuilder.mockReturnValue(makeQb(rows));
      client.track.mockRejectedValue(new PosteTrackingError('HTTP 403 da Poste', 'http'));
      await service.handleCron();
      expect(client.track).toHaveBeenCalledTimes(5);
      expect(rows.every((r) => r.status === 'pending')).toBe(true);
    });
  });

  describe('checkRecipientNow', () => {
    it('crea la riga al volo se manca e controlla subito', async () => {
      recipientRepo.findOne.mockResolvedValue({ id: 'r1', campaignId: 'c1' });
      attemptRepo.findOne.mockResolvedValue({ id: 'a1', channelType: 'POSTAL', postalStatus: 'NonConsegnato', postalAcceptanceId: 'RN000000000IT' });
      client.track.mockResolvedValue(DELIVERED);
      const r = await service.checkRecipientNow('c1', 'r1');
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ attemptId: 'a1', trackingCode: 'RN000000000IT', status: 'pending' }));
      expect(r.status).toBe('delivered');
      expect(r.checkCount).toBe(0);
    });

    it('400 se l\'ultimo attempt non è NonConsegnato e non ha riga', async () => {
      recipientRepo.findOne.mockResolvedValue({ id: 'r1', campaignId: 'c1' });
      attemptRepo.findOne.mockResolvedValue({ id: 'a1', channelType: 'POSTAL', postalStatus: 'Consegnato', postalAcceptanceId: 'RN000000000IT' });
      await expect(service.checkRecipientNow('c1', 'r1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('409 se disattivato', async () => {
      settings.get.mockResolvedValue(false);
      await expect(service.checkRecipientNow('c1', 'r1')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('run di campagna', () => {
    it('ignora next_check_at, include gave_up, stato run aggiornato', async () => {
      const qb = makeQb([row({ id: 't1' }), row({ id: 't2', status: 'gave_up', checkCount: 90, nextCheckAt: null })]);
      repo.createQueryBuilder.mockReturnValue(qb);
      client.track.mockResolvedValueOnce(DELIVERED).mockRejectedValueOnce(new PosteTrackingError('x', 'network'));
      expect(await service.startCampaignRun('c1')).toEqual({ total: 2 });
      await vi.waitFor(() => expect(service.getCampaignRun('c1').running).toBe(false));
      const state = service.getCampaignRun('c1');
      expect(state).toMatchObject({ total: 2, done: 2, delivered: 1, errors: 1, aborted: false });
      expect(state.finishedAt).not.toBeNull();
      expect(whereSql(qb)).not.toContain('next_check_at');
      expect(repo.query.mock.calls[0][1]).toEqual(['c1']);
    });

    it('409 se già in corso sulla stessa campagna', async () => {
      repo.createQueryBuilder.mockReturnValue(makeQb([row()]));
      let release!: () => void;
      client.track.mockReturnValue(new Promise((res) => { release = () => res(NOT_FOUND); }));
      await service.startCampaignRun('c1');
      await expect(service.startCampaignRun('c1')).rejects.toBeInstanceOf(ConflictException);
      release();
      await vi.waitFor(() => expect(service.getCampaignRun('c1').running).toBe(false));
    });

    it('stato vuoto se mai lanciato', () => {
      expect(service.getCampaignRun('zzz')).toMatchObject({ running: false, total: 0, startedAt: null });
    });
  });
});
