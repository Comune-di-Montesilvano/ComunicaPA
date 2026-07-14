import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EnginesController } from './engines.controller';
import { NotificationQueuesService } from '../queue/notification-queues.service';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
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

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EnginesController],
      providers: [
        {
          provide: NotificationQueuesService,
          useValue: mockQueuesService,
        },
        {
          provide: getRepositoryToken(NotificationAttempt),
          useValue: mockAttemptRepo,
        },
      ],
    }).compile();

    controller = module.get<EnginesController>(EnginesController);
  });

  it('list() ritorna lo stato di tutti i motori (4 canali + protocollazione)', async () => {
    const res = await controller.list();
    expect(res.engines).toHaveLength(5);
    expect(res.engines[0]).toEqual({
      channel: 'EMAIL',
      queueName: 'notifications-email',
      paused: false,
      counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
    });
    expect(res.engines.map((e: any) => e.channel)).toContain('PROTOCOLLAZIONE');
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
      .mockResolvedValueOnce(2) // protocollato non inviato
      .mockResolvedValueOnce(10) // inviato
      .mockResolvedValueOnce(1); // fallito

    const result = await controller.sendStageCounts();

    expect(result).toEqual({ protocollato: 2, inviato: 10, fallito: 1 });
  });
});
