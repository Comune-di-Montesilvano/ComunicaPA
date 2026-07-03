import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PecStrategy } from './pec.strategy';
import { AppSettingsService } from '../../settings/app-settings.service';
import { MailConfigsService } from '../../mail-configs/mail-configs.service';

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}));

const mockConfig = {
  get: (key: string) => {
    const cfg: Record<string, unknown> = {
      'downloadLink.secret': 'test-secret',
    };
    return cfg[key];
  },
};

const settingsValues: Record<string, unknown> = {
  'pec.host': 'pec.test',
  'pec.port': 587,
  'pec.secure': false,
  'pec.user': 'u',
  'pec.password': 'p',
  'pec.from': 'noreply@pec.test.it',
  'brand.name': 'Comune Test',
  'retention.maxDays': 90,
  'system.publicUrl': 'http://api.test',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };

describe('PecStrategy', () => {
  let strategy: PecStrategy;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: 'pec-001', accepted: ['luca@pec.it'] });

    const module = await Test.createTestingModule({
      providers: [
        PecStrategy,
        { provide: ConfigService, useValue: mockConfig },
        { provide: AppSettingsService, useValue: mockSettings },
        {
          provide: MailConfigsService,
          useValue: {
            resolveForSend: jest.fn().mockResolvedValue({
              host: 'localhost', port: 587, secure: false,
              authEnabled: false, username: '', password: '',
              fromAddress: 'noreply@test.local', batchSize: 100,
              batchIntervalSeconds: 60, configId: null,
            }),
          },
        },
      ],
    }).compile();

    strategy = module.get(PecStrategy);
  });

  it('is defined with channel PEC', () => {
    expect(strategy.channel).toBe('PEC');
  });

  it('send() chiama nodemailer con pec del recipient', async () => {
    const recipient = { pec: 'luca@pec.it', email: null, fullName: 'Luca', codiceFiscale: 'CF1' };
    const campaign = { name: 'T', channelConfig: { subject: 'Avviso {{fullName}}', body: 'CF: {{codiceFiscale}}' } };

    const result = await strategy.send(recipient as never, campaign as never);

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'luca@pec.it', subject: 'Avviso Luca' }),
    );
    expect(result.messageId).toBe('pec-001');
  });

  it('send() lancia BadRequestException se recipient.pec è null', async () => {
    const recipient = { pec: null, fullName: 'X', codiceFiscale: 'CF2' };
    const campaign = { name: 'T', channelConfig: {} };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow(
      'Recipient non ha indirizzo PEC',
    );
  });

  it('should propagate nodemailer error', async () => {
    const pecError = new Error('PEC connection refused');
    mockSendMail.mockRejectedValueOnce(pecError);
    const recipient = {
      id: 'r2',
      pec: 'ok@pec.it',
      email: null,
      fullName: 'Test User',
      codiceFiscale: 'TSTXXX00X00X123X',
    };
    const campaign = {
      id: 'c2',
      name: 'Test Campaign',
      channelConfig: { subject: 'Test', body: 'Body' },
    };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow(
      'PEC connection refused',
    );
  });
});
