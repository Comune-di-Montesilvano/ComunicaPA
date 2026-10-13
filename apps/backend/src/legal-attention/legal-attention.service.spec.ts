// apps/backend/src/legal-attention/legal-attention.service.spec.ts
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { LegalAttentionService } from './legal-attention.service.js';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { PostalPosteTracking } from '../entities/postal-poste-tracking.entity.js';
import { NotificationReview } from '../entities/notification-review.entity.js';
import { OperatorDirectoryService } from '../operator-directory/operator-directory.service.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';

const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY);
/** Come node-postgres legge created_at (timestamp senza fuso scritto in UTC): componenti UTC come ora locale. */
const asDriverReads = (d: Date) => new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
const OPERATOR = { username: 'mrossi', role: 'user' };
const ADMIN = { username: 'admin', role: 'admin' };

const sendCampaign = (createdBy = 'mrossi') => ({ id: 'c1', name: 'TARI 2026', channelType: 'SEND', channelConfig: {}, isTest: false, createdBy });

function recipient(id: string, campaign = sendCampaign()) {
  return { id, campaignId: campaign.id, campaign, status: 'sent', fullName: 'ROSSI MARIO', codiceFiscale: 'RSSMRA80A01H501U', inadCheck: null };
}

function attempt(recipientId: string, over: Record<string, unknown> = {}) {
  return {
    id: `a-${recipientId}`, recipientId, attemptNumber: 1, status: 'success', errorMessage: null,
    sendStatus: 'DELIVERING', sendStatusHistory: [], iun: 'AAAA-BBBB-CCCC-202609-X-1',
    postalStatus: null, postalDeliveryStatus: null, postalDeliveryDate: null, postalStatusHistory: null,
    postalAcceptanceId: null, postalTrackingId: null, sentAt: daysAgo(60), ...over,
    createdAt: asDriverReads((over.createdAt as Date | undefined) ?? daysAgo(60)),
  };
}

describe('LegalAttentionService', () => {
  let service: LegalAttentionService;
  let campaignRepo: any;
  let recipientRepo: any;
  let attemptRepo: any;
  let posteRepo: any;
  let reviewRepo: any;
  let directory: any;
  let audit: any;

  beforeEach(async () => {
    campaignRepo = { findOneBy: vi.fn() };
    recipientRepo = { find: vi.fn().mockResolvedValue([]), query: vi.fn().mockResolvedValue([]) };
    attemptRepo = { find: vi.fn().mockResolvedValue([]) };
    posteRepo = { find: vi.fn().mockResolvedValue([]) };
    reviewRepo = {
      find: vi.fn().mockResolvedValue([]),
      create: vi.fn((x) => x),
      save: vi.fn(async (x) => x),
    };
    directory = { resolveMany: vi.fn().mockResolvedValue({ mrossi: 'Mario Rossi' }) };
    audit = { log: vi.fn() };
    const module = await Test.createTestingModule({
      providers: [
        LegalAttentionService,
        { provide: getRepositoryToken(Campaign), useValue: campaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: recipientRepo },
        { provide: getRepositoryToken(NotificationAttempt), useValue: attemptRepo },
        { provide: getRepositoryToken(PostalPosteTracking), useValue: posteRepo },
        { provide: getRepositoryToken(NotificationReview), useValue: reviewRepo },
        { provide: OperatorDirectoryService, useValue: directory },
        { provide: AuditLogsService, useValue: audit },
      ],
    }).compile();
    service = module.get(LegalAttentionService);
  });

  describe('getSummary', () => {
    it('operatore: filtra per created_by e risolve il nome', async () => {
      recipientRepo.query.mockResolvedValueOnce([{ campaign_id: 'c1', name: 'TARI 2026', channel_type: 'SEND', created_by: 'mrossi', blocking_count: 2, stale_count: 3 }]);
      const res = await service.getSummary(OPERATOR);
      const [sql, params] = recipientRepo.query.mock.calls[0];
      expect(sql).toContain('c.created_by = $1');
      expect(params).toEqual(['mrossi']);
      expect(res.items).toEqual([{ campaignId: 'c1', name: 'TARI 2026', channelType: 'SEND', createdBy: 'mrossi', createdByDisplayName: 'Mario Rossi', blockingCount: 2, staleCount: 3 }]);
    });
    it('admin: nessun filtro proprietario; nome mancante → username', async () => {
      recipientRepo.query.mockResolvedValueOnce([{ campaign_id: 'c2', name: 'X', channel_type: 'POSTAL', created_by: 'altro', blocking_count: 1, stale_count: 0 }]);
      const res = await service.getSummary(ADMIN);
      const [sql, params] = recipientRepo.query.mock.calls[0];
      expect(sql).not.toContain('c.created_by = $1');
      expect(params).toEqual([]);
      expect(res.items[0].createdByDisplayName).toBe('altro');
    });
  });

  describe('getSummary — cache', () => {
    const row = { campaign_id: 'c1', name: 'TARI 2026', channel_type: 'SEND', created_by: 'mrossi', blocking_count: 1, stale_count: 0 };

    it('seconda chiamata entro 60s dallo stesso utente: nessuna nuova query', async () => {
      recipientRepo.query.mockResolvedValue([row]);
      await service.getSummary(OPERATOR);
      const again = await service.getSummary(OPERATOR);
      expect(recipientRepo.query).toHaveBeenCalledTimes(1);
      expect(again.items[0].blockingCount).toBe(1);
    });

    it('cache separata per utente', async () => {
      recipientRepo.query.mockResolvedValue([row]);
      await service.getSummary(OPERATOR);
      await service.getSummary(ADMIN);
      expect(recipientRepo.query).toHaveBeenCalledTimes(2);
    });

    it('refresh scavalca la cache se è più vecchia di 10s', async () => {
      vi.useFakeTimers();
      try {
        recipientRepo.query.mockResolvedValue([row]);
        await service.getSummary(OPERATOR);
        vi.advanceTimersByTime(10_001);
        await service.getSummary(OPERATOR, { refresh: true });
        expect(recipientRepo.query).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('refresh ripetuto entro 10s: usa la cache (niente query a raffica)', async () => {
      recipientRepo.query.mockResolvedValue([row]);
      await service.getSummary(OPERATOR);
      await service.getSummary(OPERATOR, { refresh: true });
      await service.getSummary(OPERATOR, { refresh: true });
      expect(recipientRepo.query).toHaveBeenCalledTimes(1);
    });

    it('scaduta dopo 60s', async () => {
      vi.useFakeTimers();
      try {
        recipientRepo.query.mockResolvedValue([row]);
        await service.getSummary(OPERATOR);
        vi.advanceTimersByTime(60_001);
        await service.getSummary(OPERATOR);
        expect(recipientRepo.query).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('una presa visione applicata svuota la cache di tutti', async () => {
      recipientRepo.query.mockResolvedValue([row]);
      await service.getSummary(OPERATOR);
      await service.getSummary(ADMIN);
      recipientRepo.find.mockResolvedValueOnce([recipient('r1')]);
      attemptRepo.find.mockResolvedValueOnce([attempt('r1', { sendStatus: 'REFUSED' })]);
      reviewRepo.find.mockResolvedValueOnce([]);
      await service.applyReviews({ recipientIds: ['r1'], action: 'ack' }, OPERATOR);
      await service.getSummary(OPERATOR);
      await service.getSummary(ADMIN);
      expect(recipientRepo.query).toHaveBeenCalledTimes(4);
    });
  });

  describe('getCampaignItems', () => {
    it('404 se la campagna non esiste o è fuori perimetro', async () => {
      campaignRepo.findOneBy.mockResolvedValueOnce(null);
      await expect(service.getCampaignItems('c1', ADMIN, 1, 50)).rejects.toBeInstanceOf(NotFoundException);
      campaignRepo.findOneBy.mockResolvedValueOnce({ ...sendCampaign(), channelType: 'PEC' });
      await expect(service.getCampaignItems('c1', ADMIN, 1, 50)).rejects.toBeInstanceOf(NotFoundException);
    });
    it('403 se operatore non proprietario', async () => {
      campaignRepo.findOneBy.mockResolvedValueOnce(sendCampaign('altro'));
      await expect(service.getCampaignItems('c1', OPERATOR, 1, 50)).rejects.toBeInstanceOf(ForbiddenException);
    });
    it('righe con motivo calcolato in TS, ultima review e codici', async () => {
      campaignRepo.findOneBy.mockResolvedValueOnce(sendCampaign());
      recipientRepo.query.mockResolvedValueOnce([{ recipient_id: 'r1', kind: 'blocking', total: 1 }]);
      recipientRepo.find.mockResolvedValueOnce([recipient('r1')]);
      attemptRepo.find.mockResolvedValueOnce([attempt('r1', { sendStatus: 'REFUSED' })]);
      reviewRepo.find.mockResolvedValueOnce([{ recipientId: 'r1', kind: 'stale', action: 'ack', snoozedUntil: null, note: 'ok', createdBy: 'mrossi', createdAt: daysAgo(5) }]);
      const res = await service.getCampaignItems('c1', OPERATOR, 1, 50);
      const [, params] = recipientRepo.query.mock.calls[0];
      expect(params).toEqual(['c1', 50, 0]);
      expect(res.total).toBe(1);
      expect(res.items[0]).toMatchObject({
        recipientId: 'r1', fullName: 'ROSSI MARIO', codiceFiscale: 'RSSMRA80A01H501U', kind: 'blocking',
        reason: 'Rifiutata da SEND', iun: 'AAAA-BBBB-CCCC-202609-X-1', postalCode: null,
        lastReview: { action: 'ack', note: 'ok', createdBy: 'mrossi', createdByDisplayName: 'Mario Rossi' },
      });
    });
    it('pageSize limitato a 200 e page minima 1', async () => {
      campaignRepo.findOneBy.mockResolvedValueOnce(sendCampaign());
      recipientRepo.query.mockResolvedValueOnce([]);
      await service.getCampaignItems('c1', OPERATOR, 0, 10_000);
      expect(recipientRepo.query.mock.calls[0][1]).toEqual(['c1', 200, 0]);
    });
  });

  describe('applyReviews', () => {
    function setup(attemptOver: Record<string, unknown>, reviews: unknown[] = [], camp = sendCampaign()) {
      recipientRepo.find.mockResolvedValueOnce([recipient('r1', camp)]);
      attemptRepo.find.mockResolvedValueOnce([attempt('r1', attemptOver)]);
      reviewRepo.find.mockResolvedValueOnce(reviews);
    }

    it('ack su notifica ferma: salva una riga e scrive audit', async () => {
      setup({});
      const res = await service.applyReviews({ recipientIds: ['r1'], action: 'ack', note: ' rinotificata ' }, OPERATOR);
      expect(res).toEqual({ applied: 1, skipped: [] });
      expect(reviewRepo.save).toHaveBeenCalledWith([expect.objectContaining({
        recipientId: 'r1', campaignId: 'c1', kind: 'stale', action: 'ack', snoozedUntil: null,
        reason: 'DELIVERING da 60 giorni', note: 'rinotificata', createdBy: 'mrossi',
      })]);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ campaignId: 'c1', campaignName: 'TARI 2026', operator: 'mrossi', action: 'LEGAL_ATTENTION_ACK' }));
    });

    it('snooze su bloccante: scartato, nessuna scrittura', async () => {
      setup({ sendStatus: 'REFUSED' });
      const until = new Date(Date.now() + 10 * DAY).toISOString();
      const res = await service.applyReviews({ recipientIds: ['r1'], action: 'snooze', snoozedUntil: until }, OPERATOR);
      expect(res).toEqual({ applied: 0, skipped: [{ recipientId: 'r1', reason: 'Posticipo non ammesso per esito bloccante' }] });
      expect(reviewRepo.save).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('snooze valido su ferma: salva snoozedUntil e audit SNOOZE', async () => {
      setup({});
      const until = new Date(Date.now() + 30 * DAY).toISOString();
      const res = await service.applyReviews({ recipientIds: ['r1'], action: 'snooze', snoozedUntil: until }, OPERATOR);
      expect(res.applied).toBe(1);
      expect(reviewRepo.save.mock.calls[0][0][0].snoozedUntil.toISOString()).toBe(until);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'LEGAL_ATTENTION_SNOOZE' }));
    });

    it('snooze senza data, passata o oltre un anno → 400', async () => {
      await expect(service.applyReviews({ recipientIds: ['r1'], action: 'snooze' }, OPERATOR)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.applyReviews({ recipientIds: ['r1'], action: 'snooze', snoozedUntil: daysAgo(1).toISOString() }, OPERATOR)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.applyReviews({ recipientIds: ['r1'], action: 'snooze', snoozedUntil: new Date(Date.now() + 400 * DAY).toISOString() }, OPERATOR)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('destinatario inesistente o non più segnalato → scartato col motivo', async () => {
      recipientRepo.find.mockResolvedValueOnce([recipient('r1')]);
      attemptRepo.find.mockResolvedValueOnce([attempt('r1', { sendStatus: 'VIEWED', sendStatusHistory: [{ status: 'VIEWED', activeFrom: '2026-09-01T10:00:00Z' }] })]);
      reviewRepo.find.mockResolvedValueOnce([]);
      const res = await service.applyReviews({ recipientIds: ['r1', 'r404'], action: 'ack' }, OPERATOR);
      expect(res).toEqual({ applied: 0, skipped: [
        { recipientId: 'r1', reason: 'Non più segnalata' },
        { recipientId: 'r404', reason: 'Destinatario non trovato' },
      ] });
    });

    it('già gestita (ack sullo stesso kind) → scartata; ack su "stale" non copre "blocking"', async () => {
      setup({}, [{ recipientId: 'r1', kind: 'stale', action: 'ack', snoozedUntil: null, createdAt: daysAgo(1) }]);
      const res1 = await service.applyReviews({ recipientIds: ['r1'], action: 'ack' }, OPERATOR);
      expect(res1.skipped).toEqual([{ recipientId: 'r1', reason: 'Già gestita' }]);

      setup({ sendStatus: 'RETURNED_TO_SENDER' }, [{ recipientId: 'r1', kind: 'stale', action: 'ack', snoozedUntil: null, createdAt: daysAgo(1) }]);
      const res2 = await service.applyReviews({ recipientIds: ['r1'], action: 'ack' }, OPERATOR);
      expect(res2.applied).toBe(1);
    });

    it('posticipo scaduto → di nuovo gestibile', async () => {
      setup({}, [{ recipientId: 'r1', kind: 'stale', action: 'snooze', snoozedUntil: daysAgo(1), createdAt: daysAgo(31) }]);
      const res = await service.applyReviews({ recipientIds: ['r1'], action: 'ack' }, OPERATOR);
      expect(res.applied).toBe(1);
    });

    it('operatore con un destinatario di campagna altrui → 403, nessuna scrittura', async () => {
      recipientRepo.find.mockResolvedValueOnce([recipient('r1'), recipient('r2', { ...sendCampaign('altro'), id: 'c2' })]);
      attemptRepo.find.mockResolvedValueOnce([attempt('r1'), attempt('r2')]);
      reviewRepo.find.mockResolvedValueOnce([]);
      await expect(service.applyReviews({ recipientIds: ['r1', 'r2'], action: 'ack' }, OPERATOR)).rejects.toBeInstanceOf(ForbiddenException);
      expect(reviewRepo.save).not.toHaveBeenCalled();
    });

    it('admin può agire su campagne altrui', async () => {
      setup({}, [], sendCampaign('altro'));
      const res = await service.applyReviews({ recipientIds: ['r1'], action: 'ack' }, ADMIN);
      expect(res.applied).toBe(1);
    });

    it('destinatario annullato → non più segnalato', async () => {
      recipientRepo.find.mockResolvedValueOnce([{ ...recipient('r1'), status: 'cancelled' }]);
      attemptRepo.find.mockResolvedValueOnce([attempt('r1')]);
      reviewRepo.find.mockResolvedValueOnce([]);
      const res = await service.applyReviews({ recipientIds: ['r1'], action: 'ack' }, OPERATOR);
      expect(res.skipped).toEqual([{ recipientId: 'r1', reason: 'Non più segnalata' }]);
    });

    it('POSTAL deceduto → bloccante col motivo GlobalCom', async () => {
      const postalCampaign = { id: 'c3', name: 'AR', channelType: 'POSTAL', channelConfig: { postalServiceType: 'RaccomandataMarket4', postalReturnReceipt: true }, isTest: false, createdBy: 'mrossi' };
      recipientRepo.find.mockResolvedValueOnce([recipient('r1', postalCampaign)]);
      attemptRepo.find.mockResolvedValueOnce([attempt('r1', { sendStatus: null, postalStatus: 'Restituito', postalDeliveryStatus: 'Destinatario deceduto', createdAt: daysAgo(3) })]);
      reviewRepo.find.mockResolvedValueOnce([]);
      await service.applyReviews({ recipientIds: ['r1'], action: 'ack' }, OPERATOR);
      expect(reviewRepo.save.mock.calls[0][0][0]).toMatchObject({ kind: 'blocking', reason: 'Destinatario deceduto' });
    });
  });
});
