import { Test, TestingModule } from '@nestjs/testing';
import { EnginesController } from './engines.controller';
import { NotificationQueuesService } from '../queue/notification-queues.service';
import { BadRequestException } from '@nestjs/common';

describe('EnginesController', () => {
  let controller: EnginesController;
  const mockQueuesService = {
    isPaused: jest.fn().mockResolvedValue(false),
    getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }),
    pause: jest.fn(),
    resume: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EnginesController],
      providers: [
        {
          provide: NotificationQueuesService,
          useValue: mockQueuesService,
        },
      ],
    }).compile();

    controller = module.get<EnginesController>(EnginesController);
  });

  it('list() ritorna lo stato di tutti i canali', async () => {
    const res = await controller.list();
    expect(res.engines).toHaveLength(5);
    expect(res.engines[0]).toEqual({
      channel: 'EMAIL',
      queueName: 'notifications-email',
      paused: false,
      counts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 },
    });
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
});
