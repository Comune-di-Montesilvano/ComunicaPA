import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EnginesController } from './engines.controller';
import { NotificationQueuesService } from '../queue/notification-queues.service';
import { PostalStatusSyncService } from '../channels/postal/postal-status-sync.service';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { Campaign } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { BadRequestException } from '@nestjs/common';

describe('EnginesController', () => {
  let controller: EnginesController;
  const mockQueuesService = {
    isPaused: jest.fn().mockResolvedValue(false),
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
    pause: jest.fn(),
    resume: jest.fn(),
    getJobsDetail: jest.fn().mockResolvedValue([{ jobId: 'j1' }]),
  };
  const mockAttemptRepo = { count: jest.fn(), createQueryBuilder: jest.fn() };
  const mockCampaignRepo = { count: jest.fn().mockResolvedValue(0) };
  const mockRecipientRepo = { count: jest.fn().mockResolvedValue(0) };
  const mockPostalStatusSync = { getQueueHealth: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EnginesController],
      providers: [
        { provide: NotificationQueuesService, useValue: mockQueuesService },
        { provide: PostalStatusSyncService, useValue: mockPostalStatusSync },
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
      ],
    }).compile();

    controller = module.get<EnginesController>(EnginesController);
  });

  it('list() ritorna 6 motori (5 code BullMQ pausabili + INAD non pausabile), nessun SEND', async () => {
    const res = await controller.list();
    expect(res.engines).toHaveLength(6);
    expect(res.engines[0]).toEqual({
      channel: 'EMAIL',
      queueName: 'notifications-email',
      paused: false,
      pausable: true,
      counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
    });
    expect(res.engines.map((e: any) => e.channel)).toContain('PROTOCOLLAZIONE');
    expect(res.engines.map((e: any) => e.channel)).not.toContain('SEND');
    const inad = res.engines.find((e: any) => e.channel === 'INAD');
    expect(inad).toBeDefined();
    expect(inad!.pausable).toBe(false);
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

  it('jobs() ritorna i job del canale richiesto', async () => {
    const result = await controller.jobs('email', 'failed', '10');
    expect(mockQueuesService.getJobsDetail).toHaveBeenCalledWith('EMAIL', 'failed', 10);
    expect(result).toEqual({ channel: 'EMAIL', status: 'failed', jobs: [{ jobId: 'j1' }] });
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
