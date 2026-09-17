import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { EnginesController } from './engines.controller.js';
import { NotificationQueuesService } from '../queue/notification-queues.service.js';
import { PostalStatusSyncService } from '../channels/postal/postal-status-sync.service.js';
import { ENRICHMENT_QUEUE } from '../enrichment/enrichment-job.types.js';
import { NotificationAttempt } from '../entities/notification-attempt.entity.js';
import { Campaign } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { BadRequestException } from '@nestjs/common';

describe('EnginesController', () => {
  let controller: EnginesController;
  const mockQueuesService = {
    isPaused: jest.fn().mockResolvedValue(false),
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
    getLastFailedAt: jest.fn().mockResolvedValue(null),
    pause: jest.fn(),
    resume: jest.fn(),
    getJobsDetail: jest.fn().mockResolvedValue([{ jobId: 'j1' }]),
  };
  const mockEnrichmentQueue = {
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 1, active: 0, completed: 5, failed: 0, delayed: 0 }),
    getFailed: jest.fn().mockResolvedValue([]),
  };
  const mockAttemptRepo = { count: jest.fn(), createQueryBuilder: jest.fn() };
  const mockCampaignRepo = { count: jest.fn().mockResolvedValue(0), find: jest.fn().mockResolvedValue([]) };
  const mockRecipientRepo = { count: jest.fn().mockResolvedValue(0) };
  const mockPostalStatusSync = { getQueueHealth: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EnginesController],
      providers: [
        { provide: NotificationQueuesService, useValue: mockQueuesService },
        { provide: PostalStatusSyncService, useValue: mockPostalStatusSync },
        { provide: getQueueToken(ENRICHMENT_QUEUE), useValue: mockEnrichmentQueue },
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
      ],
    }).compile();

    controller = module.get<EnginesController>(EnginesController);
  });

  it('list() ritorna 7 motori (5 code BullMQ pausabili + INAD + ENRICHMENT non pausabili), nessun SEND', async () => {
    const res = await controller.list();
    expect(res.engines).toHaveLength(7);
    expect(res.engines[0]).toEqual({
      channel: 'EMAIL',
      queueName: 'notifications-email',
      paused: false,
      pausable: true,
      counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
      lastFailedAt: null,
    });
    expect(res.engines.map((e: any) => e.channel)).toContain('PROTOCOLLAZIONE');
    expect(res.engines.map((e: any) => e.channel)).not.toContain('SEND');
    const inad = res.engines.find((e: any) => e.channel === 'INAD');
    expect(inad).toBeDefined();
    expect(inad!.pausable).toBe(false);
    expect(inad!.lastFailedAt).toBeNull();
    const enrichment = res.engines.find((e: any) => e.channel === 'ENRICHMENT');
    expect(enrichment).toEqual({
      channel: 'ENRICHMENT',
      queueName: ENRICHMENT_QUEUE,
      paused: false,
      pausable: false,
      counts: { waiting: 1, active: 0, completed: 5, failed: 0, delayed: 0 },
      lastFailedAt: null,
    });
  });

  it('list() popola lastFailedAt del motore ENRICHMENT dal job fallito più recente', async () => {
    mockEnrichmentQueue.getFailed.mockResolvedValueOnce([{ finishedOn: 1700000000000 }]);
    const res = await controller.list();
    const enrichment = res.engines.find((e: any) => e.channel === 'ENRICHMENT');
    expect(enrichment!.lastFailedAt).toBe(new Date(1700000000000).toISOString());
  });

  it('pause() mette in pausa un canale valido', async () => {
    const res = await controller.pause('email');
    expect(res).toEqual({ success: true, channel: 'EMAIL', paused: true });
    expect(mockQueuesService.pause).toHaveBeenCalledWith('EMAIL');
  });

  it('pause() lancia BadRequestException per un canale non valido', async () => {
    await expect(controller.pause('invalid')).rejects.toThrow(BadRequestException);
    expect(mockQueuesService.pause).not.toHaveBeenCalled();
  });

  it('resume() riattiva un canale valido', async () => {
    const res = await controller.resume('pec');
    expect(res).toEqual({ success: true, channel: 'PEC', paused: false });
    expect(mockQueuesService.resume).toHaveBeenCalledWith('PEC');
  });

  it('jobs() ritorna i job del canale richiesto, arricchiti col nome campagna', async () => {
    mockQueuesService.getJobsDetail.mockResolvedValueOnce([{ jobId: 'j1', campaignId: 'c1' }]);
    mockCampaignRepo.find.mockResolvedValueOnce([{ id: 'c1', name: 'Saldo TARI 2026' }]);

    const result = await controller.jobs('email', 'failed', '10');

    expect(mockQueuesService.getJobsDetail).toHaveBeenCalledWith('EMAIL', 'failed', 10);
    expect(mockCampaignRepo.find).toHaveBeenCalledWith({ where: { id: expect.anything() }, select: { id: true, name: true } });
    expect(result).toEqual({ channel: 'EMAIL', status: 'failed', jobs: [{ jobId: 'j1', campaignId: 'c1', campaignName: 'Saldo TARI 2026' }] });
  });

  it('jobs() con campagna non trovata (es. cancellata) ritorna campaignName null', async () => {
    mockQueuesService.getJobsDetail.mockResolvedValueOnce([{ jobId: 'j1', campaignId: 'c-eliminata' }]);
    mockCampaignRepo.find.mockResolvedValueOnce([]);

    const result = await controller.jobs('email', 'failed', '10');

    expect(result.jobs).toEqual([{ jobId: 'j1', campaignId: 'c-eliminata', campaignName: null }]);
  });

  it('jobs() rifiuta un canale sconosciuto', async () => {
    await expect(controller.jobs('fax', 'failed', '10')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('GET send/stage-counts ritorna i contatori (senza queued, ora nel motore protocollazione)', async () => {
    mockAttemptRepo.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(1);

    const result = await controller.sendStageCounts();

    expect(result).toEqual({ protocollato: 2, inviato: 10, fallito: 1 });
  });

  it('GET postal/queue-health delega a PostalStatusSyncService.getQueueHealth()', async () => {
    mockPostalStatusSync.getQueueHealth.mockResolvedValue({
      candidatesCount: 3, oldestCandidateAgeMinutes: 5, verifiedCount: 100, errorCount: 2,
    });

    const result = await controller.postalQueueHealth();

    expect(result).toEqual({ candidatesCount: 3, oldestCandidateAgeMinutes: 5, verifiedCount: 100, errorCount: 2 });
  });
});
