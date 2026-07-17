import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DelayedError } from 'bullmq';
import type { Job } from 'bullmq';
import { NotificationProcessor } from './notification.processor';
import { AppSettingsService } from '../settings/app-settings.service';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { CHANNEL_STRATEGIES } from '../channels/channel.interface';
import { THROTTLE_REDIS } from './notification-job.types';
import { MailConfigsService } from '../mail-configs/mail-configs.service';
import { IoServicesService } from '../io-services/io-services.service';
import { CampaignCompletionService } from '../campaigns/campaign-completion.service';
import type { NotificationJobData } from '@comunicapa/shared-types';

const mockRedis = {
  incr: jest.fn().mockResolvedValue(1),
  decr: jest.fn().mockResolvedValue(0),
  pexpire: jest.fn().mockResolvedValue(1),
};

const mockMailConfigs = {
  resolveForSend: jest.fn().mockResolvedValue({
    host: 'h', port: 587, secure: false, authEnabled: false, username: '',
    password: '', fromAddress: 'n@t.it', batchSize: 100,
    batchIntervalSeconds: 60, configId: null,
  }),
};

const mockAttemptRepo = {
  update: jest.fn(),
  findOne: jest.fn(),
};

const mockCampaignRepo = {
  findOne: jest.fn(),
  increment: jest.fn(),
  createQueryBuilder: jest.fn(),
};

const mockRecipientRepo = {
  findOne: jest.fn(),
  update: jest.fn(),
  count: jest.fn(),
};

const mockCampaignCompletion = { checkAndComplete: jest.fn().mockResolvedValue(undefined) };

const mockStrategy = {
  send: jest.fn(),
};

const mockPostalStrategy = {
  send: jest.fn(),
};

const mockStrategies = new Map([['EMAIL', mockStrategy], ['POSTAL', mockPostalStrategy]]);

const mockConfig = {
  get: (key: string) => {
    const cfg: Record<string, unknown> = {
      'downloadLink.secret': 'test-secret',
    };
    return cfg[key];
  },
};

const settingsValues: Record<string, unknown> = {
  'retention.maxDays': 90,
  'system.publicUrl': 'http://api.test',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };

const mockIoServices = {
  resolveApiKey: jest.fn(async () => ({ apiKey: 'key', idService: 'SVC1' })),
};

describe('NotificationProcessor', () => {
  let processor: NotificationProcessor;

  const mockJob = (data: NotificationJobData, attemptsMade = 0) =>
    ({ id: '1', data, attemptsMade } as unknown as Job<NotificationJobData>);

  const baseData: NotificationJobData = {
    campaignId: 'camp-1',
    recipientId: 'rec-1',
    attemptId: 'att-1',
    channel: 'EMAIL',
  };

  const mockCampaign = {
    id: 'camp-1',
    status: CampaignStatus.QUEUED,
    name: 'TARI',
    channelType: 'EMAIL',
    channelConfig: {},
    sentCount: 0,
    failedCount: 0,
    totalRecipients: 1,
  };

  const mockRecipient = {
    id: 'rec-1',
    email: 'mario@example.com',
    pec: null,
    fullName: 'Mario',
    codiceFiscale: 'RSSMRA85M01H501Z',
  };

  const mockQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRedis.incr.mockResolvedValue(1);

    mockCampaignRepo.findOne.mockResolvedValue(mockCampaign);
    mockRecipientRepo.findOne.mockResolvedValue(mockRecipient);
    mockAttemptRepo.findOne.mockResolvedValue({ id: 'att-1', status: AttemptStatus.QUEUED, responsePayload: null });
    mockRecipientRepo.update.mockResolvedValue(undefined);
    mockRecipientRepo.count.mockResolvedValue(1);
    mockCampaignRepo.increment.mockResolvedValue(undefined);
    mockCampaignRepo.createQueryBuilder.mockReturnValue(mockQb);
    mockStrategy.send.mockResolvedValue({ messageId: 'msg-001', responsePayload: {} });

    const module = await Test.createTestingModule({
      providers: [
        NotificationProcessor,
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
        { provide: CHANNEL_STRATEGIES, useValue: mockStrategies },
        { provide: ConfigService, useValue: mockConfig },
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: THROTTLE_REDIS, useValue: mockRedis },
        { provide: MailConfigsService, useValue: mockMailConfigs },
        { provide: IoServicesService, useValue: mockIoServices },
        { provide: CampaignCompletionService, useValue: mockCampaignCompletion },
      ],
    }).compile();

    processor = module.get(NotificationProcessor);
  });

  it('is defined', () => {
    expect(processor).toBeDefined();
  });

  describe('completamento campagna', () => {
    it('chiama CampaignCompletionService dopo un invio riuscito', async () => {
      await processor.process(mockJob(baseData));

      expect(mockCampaignCompletion.checkAndComplete).toHaveBeenCalledWith('camp-1');
    });

    it('chiama CampaignCompletionService anche quando l\'ultimo destinatario fallisce (strategy lancia)', async () => {
      mockStrategy.send.mockRejectedValueOnce(new Error('SMTP timeout'));

      await expect(processor.process(mockJob(baseData))).rejects.toThrow('SMTP timeout');

      expect(mockCampaignCompletion.checkAndComplete).toHaveBeenCalledWith('camp-1');
    });
  });

  it('process() aggiorna attempt PROCESSING → SUCCESS e chiama strategy', async () => {
    await processor.process(mockJob(baseData));

    expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', { status: AttemptStatus.PROCESSING });
    expect(mockStrategy.send).toHaveBeenCalledWith(mockRecipient, mockCampaign, expect.any(Function), 'att-1', 0);
    expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', expect.objectContaining({
      status: AttemptStatus.SUCCESS,
      responsePayload: expect.any(Object),
    }));
    expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'sentCount', 1);
    expect(mockRecipientRepo.update).toHaveBeenCalledWith('rec-1', expect.objectContaining({
      status: RecipientStatus.SENT,
      attachmentExpiresAt: expect.any(Date),
    }));
  });

  it('passa job.attemptsMade a strategy.send()', async () => {
    await processor.process(mockJob(baseData, 2));

    expect(mockStrategy.send).toHaveBeenCalledWith(
      mockRecipient, mockCampaign, expect.any(Function), 'att-1', 2,
    );
  });

  it('process() aggiorna attempt PROCESSING → FAILED e rilancia se strategy lancia', async () => {
    mockStrategy.send.mockRejectedValueOnce(new Error('SMTP timeout'));

    await expect(processor.process(mockJob(baseData))).rejects.toThrow('SMTP timeout');

    expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', expect.objectContaining({
      status: AttemptStatus.FAILED,
      errorMessage: 'SMTP timeout',
    }));
    expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'failedCount', 1);
    expect(mockRecipientRepo.update).toHaveBeenCalledWith('rec-1', { status: RecipientStatus.FAILED });
  });

  it('process() lancia Error se nessuna strategy per channel', async () => {
    const data: NotificationJobData = { ...baseData, channel: 'SEND' };

    await expect(processor.process(mockJob(data))).rejects.toThrow('Nessuna strategy per channel SEND');
  });

  it('rimanda il job con DelayedError quando il batch è pieno', async () => {
    mockRedis.incr.mockResolvedValue(101);
    const job = {
      id: '1', attemptsMade: 0, token: 'tok',
      data: { campaignId: 'camp-1', recipientId: 'rec-1', attemptId: 'att-1', channel: 'EMAIL' },
      moveToDelayed: jest.fn().mockResolvedValue(undefined),
    } as any;
    await expect(processor.process(job, 'tok')).rejects.toThrow(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalled();
    expect(mockRedis.decr).toHaveBeenCalled();
  });

  describe('redelivery: guardia contro doppio invio (BullMQ redelivery)', () => {
    it('non richiama strategy.send se l\'attempt è già SUCCESS in DB', async () => {
      mockAttemptRepo.findOne.mockResolvedValueOnce({
        id: 'att-1',
        status: AttemptStatus.SUCCESS,
        responsePayload: { messageId: 'msg-001' },
      });

      await processor.process(mockJob(baseData));

      expect(mockStrategy.send).not.toHaveBeenCalled();
      // Non deve ri-eseguire le transizioni di stato normali (già SUCCESS, non toccare).
      expect(mockAttemptRepo.update).not.toHaveBeenCalledWith('att-1', { status: AttemptStatus.PROCESSING });
    });

    it('non richiama strategy.send se responsePayload ha già notificationRequestId (PN aveva già accettato), ma completa gli aggiornamenti sospesi', async () => {
      // Simula il crash-window reale: strategy.send() ha già ottenuto l'ack dal
      // provider (notificationRequestId scritto su DB) ma il worker è morto
      // prima di completare recipient/campaign/attempt SUCCESS.
      mockAttemptRepo.findOne.mockResolvedValueOnce({
        id: 'att-1',
        status: AttemptStatus.PROCESSING,
        responsePayload: { notificationRequestId: 'req-xyz', messageId: 'req-xyz' },
      });

      await processor.process(mockJob(baseData));

      expect(mockStrategy.send).not.toHaveBeenCalled();
      // La coda di completamento va comunque eseguita, riusando il responsePayload esistente.
      expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', expect.objectContaining({
        status: AttemptStatus.SUCCESS,
        responsePayload: { notificationRequestId: 'req-xyz', messageId: 'req-xyz' },
      }));
      expect(mockRecipientRepo.update).toHaveBeenCalledWith('rec-1', expect.objectContaining({
        status: RecipientStatus.SENT,
        attachmentExpiresAt: expect.any(Date),
      }));
      expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'sentCount', 1);
    });

    it('persiste subito il responsePayload (con notificationRequestId) appena strategy.send() ha successo, prima dell\'update finale SUCCESS', async () => {
      mockStrategy.send.mockResolvedValueOnce({
        messageId: 'req-xyz',
        responsePayload: { notificationRequestId: 'req-xyz' },
      });

      await processor.process(mockJob(baseData));

      // Scrittura intermedia con solo responsePayload (senza status), che rende visibile
      // a un'eventuale redelivery l'ack del provider anche se il worker muore subito dopo.
      expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', {
        responsePayload: expect.objectContaining({ notificationRequestId: 'req-xyz' }),
      });
    });

    it('procede normalmente (chiama strategy.send) se l\'attempt non è ancora SUCCESS e non ha notificationRequestId', async () => {
      mockAttemptRepo.findOne.mockResolvedValueOnce({
        id: 'att-1',
        status: AttemptStatus.QUEUED,
        responsePayload: null,
      });

      await processor.process(mockJob(baseData));

      expect(mockStrategy.send).toHaveBeenCalled();
    });
  });

  describe('POSTAL: persistenza postalTrackingId e piggyback attemptNumber', () => {
    const postalData: NotificationJobData = { ...baseData, channel: 'POSTAL' };
    const mockCampaignPostal = { ...mockCampaign, channelType: 'POSTAL' };

    beforeEach(() => {
      mockCampaignRepo.findOne.mockResolvedValue(mockCampaignPostal);
      mockPostalStrategy.send.mockResolvedValue({ messageId: 'IDPRO123', responsePayload: { stato: 'Accettato', idPro: 'IDPRO123' } });
    });

    it('scrive postalTrackingId sulla colonna dedicata subito dopo un invio POSTAL riuscito', async () => {
      await processor.process(mockJob(postalData));

      expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', expect.objectContaining({ postalTrackingId: 'IDPRO123' }));
    });

    it('scrive subito postalStatus="Accettato" e il primo elemento di postalStatusHistory dopo un invio POSTAL riuscito', async () => {
      await processor.process(mockJob(postalData));

      expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', expect.objectContaining({
        postalStatus: 'Accettato',
        postalStatusHistory: [{ stato: 'Accettato', rilevatoIl: expect.any(String) }],
      }));
    });

    it('usa lo stato reale da responsePayload.stato invece di un valore fisso "Accettato"', async () => {
      mockPostalStrategy.send.mockResolvedValue({ messageId: 'IDPRO123', responsePayload: { stato: 'Sospeso', idPro: 'IDPRO123' } });

      await processor.process(mockJob(postalData));

      expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', expect.objectContaining({
        postalStatus: 'Sospeso',
        postalStatusHistory: [{ stato: 'Sospeso', rilevatoIl: expect.any(String) }],
      }));
    });

    it('NON scrive postalTrackingId per canali diversi da POSTAL', async () => {
      await processor.process(mockJob(baseData));

      expect(mockAttemptRepo.update).not.toHaveBeenCalledWith('att-1', expect.objectContaining({ postalTrackingId: expect.anything() }));
    });

    it('non scrive postalTrackingId se il canale primario POSTAL fallisce (nessun messageId)', async () => {
      mockPostalStrategy.send.mockRejectedValueOnce(new Error('GlobalCom down'));

      await expect(processor.process(mockJob(postalData))).rejects.toThrow('GlobalCom down');

      expect(mockAttemptRepo.update).not.toHaveBeenCalledWith('att-1', expect.objectContaining({ postalTrackingId: expect.anything() }));
    });

    it('piggyback: imposta recipient.attemptNumber da existingAttempt.attemptNumber prima di chiamare strategy.send()', async () => {
      mockAttemptRepo.findOne.mockResolvedValueOnce({
        id: 'att-1',
        status: AttemptStatus.QUEUED,
        responsePayload: null,
        attemptNumber: 3,
      });

      await processor.process(mockJob(postalData));

      expect(mockPostalStrategy.send).toHaveBeenCalledWith(
        expect.objectContaining({ attemptNumber: 3 }),
        expect.anything(), expect.any(Function), 'att-1', 0,
      );
    });

    it('piggyback: default attemptNumber=1 quando existingAttempt non ha attemptNumber', async () => {
      mockAttemptRepo.findOne.mockResolvedValueOnce({
        id: 'att-1',
        status: AttemptStatus.QUEUED,
        responsePayload: null,
      });

      await processor.process(mockJob(postalData));

      expect(mockPostalStrategy.send).toHaveBeenCalledWith(
        expect.objectContaining({ attemptNumber: 1 }),
        expect.anything(), expect.any(Function), 'att-1', 0,
      );
    });
  });

  describe('App IO indipendente dal canale primario', () => {
    const mockCampaignWithAppIo = {
      id: 'camp-1',
      status: CampaignStatus.QUEUED,
      name: 'TARI',
      channelType: 'EMAIL',
      channelConfig: { appIo: { ioServiceId: 'svc-1' } },
      retentionDays: null,
      sentCount: 0,
      failedCount: 0,
      totalRecipients: 1,
    };

    let originalFetch: any;

    beforeEach(() => {
      originalFetch = (global as any).fetch;
      mockCampaignRepo.findOne.mockResolvedValue(mockCampaignWithAppIo);
    });

    afterEach(() => {
      (global as any).fetch = originalFetch;
    });

    it("tenta comunque App IO quando il canale primario (EMAIL) fallisce, poi rilancia l'errore primario", async () => {
      mockStrategy.send.mockRejectedValueOnce(new Error('SMTP down'));
      (global as any).fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sender_allowed: true }) }) // checkAppIoProfile
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => '' }); // send message

      await expect(processor.process(mockJob(baseData))).rejects.toThrow('SMTP down');

      expect((global as any).fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/messages'),
        expect.any(Object),
      );
      expect(mockRecipientRepo.update).toHaveBeenCalledWith('rec-1', expect.objectContaining({ status: RecipientStatus.FAILED }));
      expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', expect.objectContaining({ status: AttemptStatus.FAILED }));
    });

    it('C1: NON ri-tenta App IO ai retry (job.attemptsMade > 0), evitando push duplicate', async () => {
      // Retry del job (primo canale continua a fallire): App IO NON deve essere re-inviato.
      mockStrategy.send.mockRejectedValueOnce(new Error('SMTP down'));
      (global as any).fetch = jest.fn();

      await expect(processor.process(mockJob(baseData, 1))).rejects.toThrow('SMTP down');

      // Nessuna chiamata App IO (né profilo né invio messaggio) al retry.
      expect((global as any).fetch).not.toHaveBeenCalled();
      expect(mockRecipientRepo.update).toHaveBeenCalledWith(
        'rec-1',
        expect.objectContaining({ status: RecipientStatus.FAILED }),
      );
    });

    it('I2: imposta attachmentExpiresAt quando App IO consegna il link anche se il canale primario fallisce', async () => {
      mockStrategy.send.mockRejectedValueOnce(new Error('SMTP down'));
      (global as any).fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sender_allowed: true }) }) // checkAppIoProfile
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'appio-1' }) }); // send message (successo)

      await expect(processor.process(mockJob(baseData))).rejects.toThrow('SMTP down');

      // Recipient FAILED ma con attachmentExpiresAt impostato → la retention lo cancellerà.
      expect(mockRecipientRepo.update).toHaveBeenCalledWith(
        'rec-1',
        expect.objectContaining({
          status: RecipientStatus.FAILED,
          attachmentExpiresAt: expect.any(Date),
        }),
      );
      expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'failedCount', 1);
    });

    it('percorso di successo: imposta attachmentExpiresAt e sentCount, non lancia errori', async () => {
      mockStrategy.send.mockResolvedValueOnce({ messageId: 'msg-1', responsePayload: {} });
      (global as any).fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sender_allowed: true }) }) // checkAppIoProfile
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'appio-1' }) }); // send message

      await processor.process(mockJob(baseData));

      expect(mockRecipientRepo.update).toHaveBeenCalledWith(
        'rec-1',
        expect.objectContaining({ status: RecipientStatus.SENT, attachmentExpiresAt: expect.any(Date) }),
      );
      expect(mockCampaignRepo.increment).toHaveBeenCalledWith({ id: 'camp-1' }, 'sentCount', 1);
    });

    it('exclusive: se il CF ha App IO invia solo App IO e non chiama la strategy', async () => {
      mockCampaignRepo.findOne.mockResolvedValueOnce({
        ...mockCampaignWithAppIo,
        channelConfig: { appIo: { mode: 'exclusive', ioServiceId: 'svc-1' } }
      });
      (global as any).fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sender_allowed: true }) }) // checkAppIoProfile
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'io-1' }) }); // send message

      await processor.process(mockJob(baseData));

      expect(mockStrategy.send).not.toHaveBeenCalled();
      expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', expect.objectContaining({
        status: AttemptStatus.SUCCESS,
        responsePayload: expect.objectContaining({
          deliveredVia: 'APP_IO',
          appIo: { success: true, messageId: 'io-1' }
        })
      }));
    });

    it('exclusive: per un destinatario dirottato da INAD (inadCheck.diverted) invia SEMPRE il canale primario, App IO al massimo in aggiunta', async () => {
      mockCampaignRepo.findOne.mockResolvedValueOnce({
        ...mockCampaignWithAppIo,
        channelConfig: { appIo: { mode: 'exclusive', ioServiceId: 'svc-1' } },
      });
      mockRecipientRepo.findOne.mockResolvedValueOnce({ ...mockRecipient, inadCheck: { found: true, diverted: true } });
      (global as any).fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sender_allowed: true }) }) // checkAppIoProfile (parallelo)
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'io-1' }) }); // send message
      mockStrategy.send.mockResolvedValueOnce({ messageId: 'msg-primary', responsePayload: {} });

      await processor.process(mockJob(baseData));

      // Il canale primario NON deve mai essere saltato per un destinatario
      // dirottato da INAD, anche se la campagna ha App IO in modalità esclusiva.
      expect(mockStrategy.send).toHaveBeenCalled();
      expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', expect.objectContaining({
        status: AttemptStatus.SUCCESS,
      }));
    });

    it('exclusive: se il CF NON ha App IO usa il canale primario', async () => {
      mockCampaignRepo.findOne.mockResolvedValueOnce({
        ...mockCampaignWithAppIo,
        channelConfig: { appIo: { mode: 'exclusive', ioServiceId: 'svc-1' } }
      });
      (global as any).fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sender_allowed: false }) }); // checkAppIoProfile

      mockStrategy.send.mockResolvedValueOnce({ messageId: 'msg-001', responsePayload: {} });

      await processor.process(mockJob(baseData));

      expect(mockStrategy.send).toHaveBeenCalled();
    });

    it('appIo configurata ma resolveApiKey restituisce null: logga un warning esplicito (oggi fallisce in silenzio)', async () => {
      mockCampaignRepo.findOne.mockResolvedValueOnce({
        ...mockCampaignWithAppIo,
        channelConfig: { appIo: { mode: 'parallel', ioServiceId: 'svc-eliminato' } },
      });
      (mockIoServices.resolveApiKey as jest.Mock).mockResolvedValueOnce(null);
      (global as any).fetch = jest.fn();
      mockStrategy.send.mockResolvedValueOnce({ messageId: 'msg-001', responsePayload: {} });
      const warnSpy = jest.spyOn((processor as any).logger, 'warn');

      await processor.process(mockJob(baseData));

      expect((global as any).fetch).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('svc-eliminato'));
    });

    it('appIo assente: nessuna chiamata a fetch App IO', async () => {
      mockCampaignRepo.findOne.mockResolvedValueOnce({
        ...mockCampaignWithAppIo,
        channelConfig: {}
      });
      (global as any).fetch = jest.fn();

      mockStrategy.send.mockResolvedValueOnce({ messageId: 'msg-001', responsePayload: {} });

      await processor.process(mockJob(baseData));

      expect((global as any).fetch).not.toHaveBeenCalled();
      expect(mockStrategy.send).toHaveBeenCalled();
    });

    it('usa subjectOverride/bodyOverride di secondaryChannels quando presenti (invece di subject/body principali)', async () => {
      mockCampaignRepo.findOne.mockResolvedValueOnce({
        ...mockCampaignWithAppIo,
        channelConfig: {
          subject: 'Oggetto principale',
          body: 'Corpo principale',
          secondaryChannels: [
            { channel: 'APP_IO', mode: 'parallel', ioServiceId: 'svc-1', subjectOverride: 'Oggetto IO', bodyOverride: 'Corpo IO differenziato' },
          ],
        },
      });
      let capturedBody: any;
      (global as any).fetch = jest.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ sender_allowed: true }) }) // checkAppIoProfile
        .mockImplementationOnce((_url: string, init: any) => {
          capturedBody = JSON.parse(init.body);
          return Promise.resolve({ ok: true, json: async () => ({ id: 'io-1' }) });
        });

      await processor.process(mockJob(baseData));

      expect(capturedBody.content.subject).toBe('Oggetto IO');
      expect(capturedBody.content.markdown).toBe('Corpo IO differenziato');
    });
  });
});
