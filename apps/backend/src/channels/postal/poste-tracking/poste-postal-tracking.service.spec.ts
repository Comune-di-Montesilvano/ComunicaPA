import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { PostePostalTrackingService } from './poste-postal-tracking.service.js';
import { PosteTrackingError } from './poste-tracking-mapping.util.js';
import type { PostalPosteTracking } from '../../../entities/postal-poste-tracking.entity.js';

const DELIVERED = { esitoRicerca: '3', stato: '5', flagRitorno: false, tipoProdotto: 'RACC', movements: [{ at: '2026-09-04T08:06:00.000Z', luogo: 'SVIZZERA', statoLavorazione: 'con successo in data', box: '5', flagRitorno: false }], raw: {} };
const RETURNED = { esitoRicerca: '3', stato: '5', flagRitorno: true, tipoProdotto: 'MARKET', movements: [{ at: '2026-08-20T09:00:00.000Z', luogo: 'PESCARA', statoLavorazione: 'restituita', box: '5', flagRitorno: true }], raw: {} };
const NOT_FOUND = { esitoRicerca: '1', stato: '1', flagRitorno: false, tipoProdotto: null, movements: [], raw: {} };
const BLOCKED = () => new PosteTrackingError('HTTP 400 da Poste', 'blocked');

function row(partial: Partial<PostalPosteTracking> = {}): PostalPosteTracking {
  return { id: 't1', attemptId: 'a1', trackingCode: 'RN000000000IT', status: 'pending', checkCount: 0, nextCheckAt: new Date(Date.now() - 1000), lastCheckedAt: null, lastError: null, posteStato: null, posteEsitoRicerca: null, posteProduct: null, deliveredAt: null, outcomeAt: null, trackingUntil: new Date(Date.now() + 30 * 86_400_000), movements: null, lastResponse: null, createdAt: new Date(), updatedAt: new Date(), ...partial } as PostalPosteTracking;
}

describe('PostePostalTrackingService', () => {
  let service: PostePostalTrackingService;
  let store: Map<string, PostalPosteTracking>;
  let campaignRows: PostalPosteTracking[];
  let repo: any;
  let attemptRepo: any;
  let recipientRepo: any;
  let client: { track: ReturnType<typeof vi.fn> };
  let settingsValues: Record<string, unknown>;
  let sleep: ReturnType<typeof vi.fn>;

  function add(...rows: PostalPosteTracking[]) {
    for (const r of rows) store.set(r.id, r);
  }

  // Simula la query "prossimo dovuto" del DB: pending, next_check_at scaduto.
  function dueQb() {
    const qb: any = {};
    for (const m of ['innerJoin', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'take', 'limit']) qb[m] = vi.fn().mockReturnValue(qb);
    qb.getOne = vi.fn(async () => [...store.values()].find((r) => r.status === 'pending' && r.nextCheckAt && r.nextCheckAt.getTime() <= Date.now()) ?? null);
    qb.getMany = vi.fn(async () => campaignRows);
    return qb;
  }

  beforeEach(() => {
    store = new Map();
    campaignRows = [];
    repo = {
      query: vi.fn().mockResolvedValue([]),
      save: vi.fn(async (r) => { store.set(r.id, r); return r; }),
      create: vi.fn((r) => ({ ...row({ id: 'new' }), ...r })),
      findOneBy: vi.fn(async (w: any) => (w.id ? store.get(w.id) : [...store.values()].find((r) => r.attemptId === w.attemptId)) ?? null),
      createQueryBuilder: vi.fn(() => dueQb()),
    };
    attemptRepo = { findOne: vi.fn() };
    recipientRepo = { findOne: vi.fn() };
    client = { track: vi.fn() };
    settingsValues = { 'postalPosteTracking.enabled': true, 'postalPosteTracking.intervalSeconds': 15, 'postalPosteTracking.cooldownMinutes': 30, 'postalPosteTracking.staleDays': 30 };
    const settings = { get: vi.fn(async (k: string) => settingsValues[k]) };
    service = new PostePostalTrackingService(repo, attemptRepo, recipientRepo, client as any, settings as any);
    sleep = vi.fn().mockResolvedValue(undefined);
    (service as any).sleep = sleep;
  });

  describe('backfill', () => {
    it('INSERT idempotente solo su ultimo attempt NonConsegnato con codice', async () => {
      repo.query.mockResolvedValue([{ id: 'x' }, { id: 'y' }]);
      expect(await service.backfill()).toBe(2);
      const sql = repo.query.mock.calls[0][0] as string;
      expect(sql).toContain("COALESCE(na.sent_at, na.created_at) + interval '90 days'");
      expect(sql).toContain("COALESCE(na.sent_at, na.created_at) > now() - interval '90 days'");
      expect(sql).toContain('ON CONFLICT (attempt_id) DO NOTHING');
      expect(sql).toContain("na.postal_status = 'NonConsegnato'");
      // Anche invii fermi: GlobalCom non consegnato e senza aggiornamenti da 30 giorni (Impostazioni).
      expect(sql).toContain("COALESCE(na.postal_status, '') <> 'Consegnato'");
      expect(sql).toContain("< now() - interval '30 days'");
      expect(sql).toContain('newer.attempt_number > na.attempt_number');
      expect(repo.query.mock.calls[0][1]).toEqual([]);
    });

    it('ristretto alla campagna quando passato', async () => {
      await service.backfill('c1');
      expect(repo.query.mock.calls[0][0]).toContain('r.campaign_id = $1');
      expect(repo.query.mock.calls[0][1]).toEqual(['c1']);
    });
  });

  describe('checkOne', () => {
    it('delivered: finale, data consegna e data esito, check_count++ (cron)', async () => {
      client.track.mockResolvedValue(DELIVERED);
      const r = row();
      expect(await service.checkOne(r, 'cron')).toBe('delivered');
      expect(r.checkCount).toBe(1);
      expect(r.nextCheckAt).toBeNull();
      expect(r.deliveredAt?.toISOString()).toBe('2026-09-04T08:06:00.000Z');
      expect(r.outcomeAt?.toISOString()).toBe('2026-09-04T08:06:00.000Z');
    });

    it('returned: data esito valorizzata, data consegna no', async () => {
      client.track.mockResolvedValue(RETURNED);
      const r = row();
      expect(await service.checkOne(r, 'cron')).toBe('returned');
      expect(r.outcomeAt?.toISOString()).toBe('2026-08-20T09:00:00.000Z');
      expect(r.deliveredAt).toBeNull();
    });

    it('pending (cron): prossimo controllo tra un giorno', async () => {
      client.track.mockResolvedValue(NOT_FOUND);
      const r = row({ checkCount: 3 });
      const before = Date.now();
      expect(await service.checkOne(r, 'cron')).toBe('pending');
      expect(r.checkCount).toBe(4);
      expect(r.nextCheckAt!.getTime()).toBeGreaterThanOrEqual(before + 86_400_000 - 1000);
    });

    it('finestra di 90 giorni dalla notifica scaduta: gave_up senza chiamare Poste', async () => {
      const r = row({ checkCount: 3, trackingUntil: new Date(Date.now() - 1000) });
      expect(await service.checkOne(r, 'cron')).toBe('gave_up');
      expect(client.track).not.toHaveBeenCalled();
      expect(r.nextCheckAt).toBeNull();
    });

    it('molti controlli ma finestra ancora aperta: resta pending (non conta le risposte)', async () => {
      client.track.mockResolvedValue(NOT_FOUND);
      const r = row({ checkCount: 200 });
      expect(await service.checkOne(r, 'cron')).toBe('pending');
    });

    it('ultimo controllo utile: se il prossimo cadrebbe oltre la finestra → gave_up', async () => {
      client.track.mockResolvedValue(NOT_FOUND);
      const r = row({ trackingUntil: new Date(Date.now() + 3 * 3_600_000) });
      expect(await service.checkOne(r, 'cron')).toBe('gave_up');
      expect(client.track).toHaveBeenCalledTimes(1);
    });

    it('manuale oltre la finestra: chiama comunque Poste (tasto sempre disponibile)', async () => {
      client.track.mockResolvedValue(DELIVERED);
      const r = row({ status: 'gave_up', nextCheckAt: null, trackingUntil: new Date(Date.now() - 86_400_000) });
      expect(await service.checkOne(r, 'manual')).toBe('delivered');
    });

    it('errore di rete: non consuma controllo, rimanda di un giorno', async () => {
      client.track.mockRejectedValue(new PosteTrackingError('HTTP 503 da Poste', 'http'));
      const r = row({ checkCount: 5 });
      expect(await service.checkOne(r, 'cron')).toBe('error');
      expect(r.checkCount).toBe(5);
      expect(r.lastError).toBe('HTTP 503 da Poste');
      expect(r.nextCheckAt!.getTime()).toBeGreaterThan(Date.now());
    });

    it('bloccato (4xx) o pagina HTML: non consuma controllo e NON sposta il prossimo controllo', async () => {
      for (const [i, err] of [BLOCKED(), new PosteTrackingError('Risposta Poste non JSON', 'invalid_body')].entries()) {
        client.track.mockRejectedValueOnce(err);
        const next = new Date(Date.now() - 5000);
        const r = row({ id: `b${i}`, checkCount: 2, nextCheckAt: next });
        expect(await service.checkOne(r, 'cron')).toBe('blocked');
        expect(r.checkCount).toBe(2);
        expect(r.nextCheckAt!.getTime()).toBe(next.getTime());
        expect(r.status).toBe('pending');
      }
    });

    it('manuale: non incrementa check_count e non sposta next_check_at', async () => {
      client.track.mockResolvedValue(NOT_FOUND);
      const next = new Date('2030-01-01T00:00:00Z');
      const r = row({ checkCount: 7, nextCheckAt: next });
      expect(await service.checkOne(r, 'manual')).toBe('pending');
      expect(r.checkCount).toBe(7);
      expect(r.nextCheckAt).toBe(next);
    });

    it('riga già delivered + risposta pending: conserva movimenti, risposta e date', async () => {
      client.track.mockResolvedValue(NOT_FOUND);
      const movements = DELIVERED.movements;
      const lastResponse = { esitoRicerca: '3', stato: '5' };
      const r = row({ status: 'delivered', deliveredAt: new Date('2026-09-04T08:06:00Z'), outcomeAt: new Date('2026-09-04T08:06:00Z'), movements, lastResponse, posteStato: '5', nextCheckAt: null });
      expect(await service.checkOne(r, 'manual')).toBe('delivered');
      expect(r.movements).toBe(movements);
      expect(r.lastResponse).toBe(lastResponse);
      expect(r.outcomeAt?.toISOString()).toBe('2026-09-04T08:06:00.000Z');
    });

    it('ricarica la riga prima di applicare l\'esito: snapshot vecchio non riporta indietro un delivered', async () => {
      client.track.mockResolvedValue(NOT_FOUND);
      add(row({ id: 't9', status: 'delivered', checkCount: 4, nextCheckAt: null }));
      const stale = row({ id: 't9', status: 'pending', checkCount: 4 });
      expect(await service.checkOne(stale, 'cron')).toBe('delivered');
      expect(stale.checkCount).toBe(4);
    });
  });

  describe('max una chiamata ogni 23 ore per notifica', () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

    it('manuale: controllata con successo 2 ore fa → skipped, nessuna chiamata, riga invariata', async () => {
      const r = row({ lastCheckedAt: hoursAgo(2), lastError: null, checkCount: 3 });
      expect(await service.checkOne(r, 'manual')).toBe('skipped');
      expect(client.track).not.toHaveBeenCalled();
      expect(r.checkCount).toBe(3);
    });

    it('ultimo tentativo fallito (blocco/rete) → si può riprovare subito', async () => {
      client.track.mockResolvedValue(NOT_FOUND);
      const r = row({ lastCheckedAt: hoursAgo(1), lastError: 'HTTP 400 da Poste' });
      expect(await service.checkOne(r, 'manual')).toBe('pending');
      expect(client.track).toHaveBeenCalledTimes(1);
    });

    it('oltre 23 ore → chiama Poste', async () => {
      client.track.mockResolvedValue(NOT_FOUND);
      const r = row({ lastCheckedAt: hoursAgo(23.1), lastError: null });
      expect(await service.checkOne(r, 'cron')).toBe('pending');
      expect(client.track).toHaveBeenCalledTimes(1);
    });

    it('cron: giorno già controllato a mano → nessuna chiamata, giorno contato, prossimo controllo a 24 ore dall\'ultimo', async () => {
      const last = hoursAgo(3);
      const r = row({ lastCheckedAt: last, lastError: null, checkCount: 4 });
      expect(await service.checkOne(r, 'cron')).toBe('skipped');
      expect(client.track).not.toHaveBeenCalled();
      expect(r.checkCount).toBe(5);
      expect(r.nextCheckAt!.getTime()).toBe(last.getTime() + 86_400_000);
      expect(repo.save).toHaveBeenCalledWith(r);
    });

    it('cron: skip con finestra che si chiude prima del prossimo controllo → gave_up', async () => {
      const r = row({ lastCheckedAt: hoursAgo(3), lastError: null, trackingUntil: new Date(Date.now() + 3_600_000) });
      expect(await service.checkOne(r, 'cron')).toBe('skipped');
      expect(r.status).toBe('gave_up');
      expect(r.nextCheckAt).toBeNull();
    });

    it('tick: una riga saltata non viene ripescata all\'infinito e non consuma la pausa', async () => {
      add(row({ id: 't1', lastCheckedAt: hoursAgo(2), lastError: null }), row({ id: 't2' }));
      client.track.mockResolvedValue(NOT_FOUND);
      await service.tick();
      expect(client.track).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('run di campagna: le controllate nelle ultime 23 ore sono conteggiate come saltate', async () => {
      campaignRows = [row({ id: 'c-1', lastCheckedAt: hoursAgo(1), lastError: null }), row({ id: 'c-2' })];
      add(...campaignRows);
      client.track.mockResolvedValue(NOT_FOUND);
      await service.startCampaignRun('c1');
      await vi.waitFor(() => expect(service.getCampaignRun('c1').running).toBe(false));
      expect(client.track).toHaveBeenCalledTimes(1);
      expect(service.getCampaignRun('c1')).toMatchObject({ done: 2, skipped: 1 });
    });

    it('tasto notifica: restituisce l\'esito della verifica (skipped) senza chiamare Poste', async () => {
      recipientRepo.findOne.mockResolvedValue({ id: 'r1', campaignId: 'c1' });
      attemptRepo.findOne.mockResolvedValue({ id: 'a1', channelType: 'POSTAL', postalStatus: 'NonConsegnato', postalAcceptanceId: 'RN000000000IT' });
      add(row({ id: 't1', attemptId: 'a1', lastCheckedAt: hoursAgo(2), lastError: null }));
      const { row: r, result } = await service.checkRecipientNow('c1', 'r1');
      expect(result).toBe('skipped');
      expect(r.id).toBe('t1');
      expect(client.track).not.toHaveBeenCalled();
    });
  });

  describe('priorità della coda', () => {
    function orderSql(qb: any): string {
      return [qb.orderBy, qb.addOrderBy].flatMap((f: any) => f.mock.calls.map((c: any[]) => c.join(' '))).join(' | ');
    }

    it('dovuti del giorno: prima i mai controllati su Poste, poi i controllati più vecchi; LIMIT semplice, mai take()', async () => {
      add(row({ id: 't1' }));
      client.track.mockResolvedValue(NOT_FOUND);
      await service.tick();
      const qb = repo.createQueryBuilder.mock.results[0].value;
      const order = orderSql(qb);
      expect(order.indexOf('poste_esito_ricerca IS NULL')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('poste_esito_ricerca IS NULL')).toBeLessThan(order.indexOf('t.last_checked_at'));
      expect(order).toContain('NULLS FIRST');
      expect(qb.limit).toHaveBeenCalledWith(1);
      expect(qb.take).not.toHaveBeenCalled();
    });

    it('run di campagna: stesso ordinamento', async () => {
      campaignRows = [];
      await service.startCampaignRun('c1');
      const qb = repo.createQueryBuilder.mock.results[0].value;
      const order = orderSql(qb);
      expect(order.indexOf('poste_esito_ricerca IS NULL')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('poste_esito_ricerca IS NULL')).toBeLessThan(order.indexOf('t.last_checked_at'));
    });
  });

  describe('tick (coda a goccia)', () => {
    it('kill-switch: nessuna chiamata se disattivato', async () => {
      settingsValues['postalPosteTracking.enabled'] = false;
      add(row());
      await service.tick();
      expect(repo.query).not.toHaveBeenCalled();
      expect(client.track).not.toHaveBeenCalled();
    });

    it('smaltisce i dovuti uno alla volta con la pausa da Impostazioni (+ variazione)', async () => {
      add(row({ id: 't1' }), row({ id: 't2' }), row({ id: 't3' }));
      client.track.mockResolvedValue(NOT_FOUND);
      await service.tick();
      expect(client.track).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
      for (const [ms] of sleep.mock.calls) {
        expect(ms).toBeGreaterThanOrEqual(15_000);
        expect(ms).toBeLessThanOrEqual(15_000 * 1.3);
      }
      const qb = repo.createQueryBuilder.mock.results[0].value;
      const where = [qb.where, qb.andWhere].flatMap((f: any) => f.mock.calls.map((c: any[]) => c[0])).join(' ');
      expect(where).toContain("COALESCE(a.postal_status, '') <> 'Consegnato'");
      expect(where).toContain('t.next_check_at <= now()');
    });

    it('due blocchi consecutivi: pausa di 30 minuti, nessun altro controllo fino alla ripresa', async () => {
      add(row({ id: 't1' }), row({ id: 't2' }));
      client.track.mockRejectedValue(BLOCKED());
      const before = Date.now();
      await service.tick();
      expect(client.track).toHaveBeenCalledTimes(2);
      const until = service.getBlockedUntil();
      expect(until!.getTime()).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1000);
      expect([...store.values()].every((r) => r.status === 'pending' && r.checkCount === 0)).toBe(true);

      client.track.mockClear();
      await service.tick();
      expect(client.track).not.toHaveBeenCalled();
    });

    it('pausa raddoppia a ogni nuovo blocco fino a 4 ore, si azzera al primo successo', async () => {
      add(row({ id: 't1' }));
      client.track.mockRejectedValue(BLOCKED());
      const pauses: number[] = [];
      for (let i = 0; i < 5; i++) {
        (service as any).blockedUntil = null;
        const t0 = Date.now();
        await service.tick();
        pauses.push(Math.round((service.getBlockedUntil()!.getTime() - t0) / 60_000));
      }
      expect(pauses).toEqual([30, 60, 120, 240, 240]);

      (service as any).blockedUntil = null;
      client.track.mockResolvedValue(NOT_FOUND);
      await service.tick();
      store.get('t1')!.nextCheckAt = new Date(Date.now() - 1000);
      store.get('t1')!.lastCheckedAt = new Date(Date.now() - 24 * 3_600_000);
      (service as any).blockedUntil = null;
      client.track.mockRejectedValue(BLOCKED());
      const t0 = Date.now();
      await service.tick();
      expect(Math.round((service.getBlockedUntil()!.getTime() - t0) / 60_000)).toBe(30);
    });

    it('un blocco isolato seguito da successo non mette in pausa', async () => {
      add(row({ id: 't1' }), row({ id: 't2' }));
      client.track.mockRejectedValueOnce(BLOCKED()).mockResolvedValue(NOT_FOUND);
      await service.tick();
      expect(service.getBlockedUntil()).toBeNull();
      expect([...store.values()].every((r) => r.checkCount === 1)).toBe(true);
    });

    it('5 errori di rete consecutivi fermano il giro senza pausa', async () => {
      for (let i = 0; i < 8; i++) add(row({ id: `t${i}` }));
      client.track.mockRejectedValue(new PosteTrackingError('x', 'network'));
      await service.tick();
      expect(client.track).toHaveBeenCalledTimes(5);
      expect(service.getBlockedUntil()).toBeNull();
    });

    it('non rientrante: un tick durante un giro in corso non parte', async () => {
      add(row({ id: 't1' }));
      let release!: () => void;
      client.track.mockReturnValue(new Promise((res) => { release = () => res(NOT_FOUND); }));
      const first = service.tick();
      await vi.waitFor(() => expect(client.track).toHaveBeenCalledTimes(1));
      await service.tick();
      expect(client.track).toHaveBeenCalledTimes(1);
      release();
      await first;
    });
  });

  describe('salute della coda (tab Motori)', () => {
    it('conteggi per stato, dovuti adesso, pausa e ultimo giro', async () => {
      repo.query.mockResolvedValue([
        { status: 'pending', n: 120, due: 40 },
        { status: 'delivered', n: 7, due: 0 },
        { status: 'returned', n: 3, due: 0 },
        { status: 'gave_up', n: 2, due: 0 },
      ]);
      (service as any).blockedUntil = new Date(Date.now() + 600_000);
      const h = await service.getQueueHealth();
      expect(h).toMatchObject({ enabled: true, pending: 120, dueNow: 40, delivered: 7, returned: 3, gaveUp: 2, processing: false, intervalSeconds: 15, activeCampaignRuns: 0 });
      expect(h.blockedUntil).not.toBeNull();
      expect(h.lastTickAt).toBeNull();
    });

    it('ultimo giro registrato dopo un tick', async () => {
      add(row({ id: 't1' }));
      client.track.mockResolvedValue(NOT_FOUND);
      await service.tick();
      repo.query.mockResolvedValue([]);
      const h = await service.getQueueHealth();
      expect(h.lastTickAt).not.toBeNull();
      expect(h.lastTickChecks).toBe(1);
    });
  });

  describe('checkRecipientNow', () => {
    it('crea la riga al volo se manca e controlla subito', async () => {
      recipientRepo.findOne.mockResolvedValue({ id: 'r1', campaignId: 'c1' });
      attemptRepo.findOne.mockResolvedValue({ id: 'a1', channelType: 'POSTAL', postalStatus: 'NonConsegnato', postalAcceptanceId: 'RN000000000IT', sentAt: new Date('2026-07-29T18:05:03Z'), createdAt: new Date('2026-07-29T18:00:00Z') });
      client.track.mockResolvedValue(DELIVERED);
      const { row: r, result } = await service.checkRecipientNow('c1', 'r1');
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ attemptId: 'a1', trackingCode: 'RN000000000IT', status: 'pending', trackingUntil: new Date('2026-10-27T18:05:03Z') }));
      expect(r.status).toBe('delivered');
      expect(result).toBe('delivered');
    });

    it('invio fermo (GlobalCom Confermato) senza riga: la crea e controlla', async () => {
      recipientRepo.findOne.mockResolvedValue({ id: 'r1', campaignId: 'c1' });
      attemptRepo.findOne.mockResolvedValue({ id: 'a1', channelType: 'POSTAL', postalStatus: 'Confermato', postalAcceptanceId: 'RN000000000IT', sentAt: new Date(), createdAt: new Date() });
      client.track.mockResolvedValue(DELIVERED);
      const { result } = await service.checkRecipientNow('c1', 'r1');
      expect(result).toBe('delivered');
    });

    it('soglia "fermo" da Impostazioni nel backfill', async () => {
      settingsValues['postalPosteTracking.staleDays'] = 45;
      await service.backfill();
      expect(repo.query.mock.calls[0][0]).toContain("< now() - interval '45 days'");
    });

    it('400 se GlobalCom dà già consegnato e non c\'è riga', async () => {
      recipientRepo.findOne.mockResolvedValue({ id: 'r1', campaignId: 'c1' });
      attemptRepo.findOne.mockResolvedValue({ id: 'a1', channelType: 'POSTAL', postalStatus: 'Consegnato', postalAcceptanceId: 'RN000000000IT' });
      await expect(service.checkRecipientNow('c1', 'r1')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('409 se disattivato o se Poste sta limitando le richieste', async () => {
      settingsValues['postalPosteTracking.enabled'] = false;
      await expect(service.checkRecipientNow('c1', 'r1')).rejects.toBeInstanceOf(ConflictException);
      settingsValues['postalPosteTracking.enabled'] = true;
      (service as any).blockedUntil = new Date(Date.now() + 60_000);
      await expect(service.checkRecipientNow('c1', 'r1')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('run di campagna (priorità nella stessa coda)', () => {
    it('le righe della campagna passano prima dei dovuti del giorno, anche gave_up e non ancora scadute', async () => {
      const future = new Date(Date.now() + 86_400_000);
      campaignRows = [row({ id: 'c-1', nextCheckAt: future }), row({ id: 'c-2', status: 'gave_up', checkCount: 90, nextCheckAt: null })];
      add(...campaignRows, row({ id: 'daily-1' }));
      client.track.mockResolvedValueOnce(DELIVERED).mockResolvedValue(NOT_FOUND);
      expect(await service.startCampaignRun('c1')).toEqual({ total: 2 });
      await vi.waitFor(() => expect(service.getCampaignRun('c1').running).toBe(false));
      const codes = client.track.mock.calls.map((c) => c[0]);
      expect(codes).toHaveLength(3);
      expect(store.get('c-1')!.status).toBe('delivered');
      expect(store.get('daily-1')!.checkCount).toBe(1);
      expect(store.get('c-2')!.checkCount).toBe(90);
      expect(service.getCampaignRun('c1')).toMatchObject({ total: 2, done: 2, delivered: 1, remaining: 0 });
      expect(repo.query.mock.calls.some((c: any[]) => JSON.stringify(c[1]) === '["c1"]')).toBe(true);
    });

    it('in pausa per blocco: run resta attivo con blockedUntil, riprende dopo', async () => {
      campaignRows = [row({ id: 'c-1' })];
      add(...campaignRows);
      client.track.mockRejectedValue(BLOCKED());
      await service.startCampaignRun('c1');
      await vi.waitFor(() => expect(service.getCampaignRun('c1').blockedUntil).not.toBeNull());
      expect(service.getCampaignRun('c1')).toMatchObject({ running: true, done: 0, remaining: 1 });

      (service as any).blockedUntil = null;
      client.track.mockResolvedValue(DELIVERED);
      await service.tick();
      expect(service.getCampaignRun('c1')).toMatchObject({ running: false, done: 1, delivered: 1 });
    });

    it('409 se già in corso sulla stessa campagna', async () => {
      campaignRows = [row({ id: 'c-1' })];
      add(...campaignRows);
      let release!: () => void;
      client.track.mockReturnValue(new Promise((res) => { release = () => res(NOT_FOUND); }));
      await service.startCampaignRun('c1');
      await expect(service.startCampaignRun('c1')).rejects.toBeInstanceOf(ConflictException);
      release();
      await vi.waitFor(() => expect(service.getCampaignRun('c1').running).toBe(false));
    });

    it('stima tempo residuo = rimanenti × intervallo', async () => {
      campaignRows = [row({ id: 'c-1' }), row({ id: 'c-2' }), row({ id: 'c-3' })];
      add(...campaignRows);
      let release!: () => void;
      client.track.mockReturnValue(new Promise((res) => { release = () => res(NOT_FOUND); }));
      await service.startCampaignRun('c1');
      expect(service.getCampaignRun('c1')).toMatchObject({ remaining: 3, etaSeconds: 45 });
      release();
      client.track.mockResolvedValue(NOT_FOUND);
      await vi.waitFor(() => expect(service.getCampaignRun('c1').running).toBe(false));
    });

    it('stato vuoto se mai lanciato', () => {
      expect(service.getCampaignRun('zzz')).toMatchObject({ running: false, total: 0, startedAt: null, blockedUntil: null });
    });
  });
});
