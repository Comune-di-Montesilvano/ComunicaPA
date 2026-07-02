import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EmailStrategy } from './email.strategy';
import { AppSettingsService } from '../../settings/app-settings.service';

const mockSendMail = jest.fn();
const mockCreateTransport = jest.fn<{ sendMail: jest.Mock }, [unknown?]>(() => ({ sendMail: mockSendMail }));

jest.mock('nodemailer', () => ({
  createTransport: (opts: unknown) => mockCreateTransport(opts),
}));

const mockConfig = {
  get: (key: string) => {
    const cfg: Record<string, unknown> = {
      'origins.publicApi': 'http://api.test',
      'downloadLink.secret': 'test-secret',
    };
    return cfg[key];
  },
};

const settingsValues: Record<string, unknown> = {
  'smtp.host': 'smtp.test',
  'smtp.port': 587,
  'smtp.secure': false,
  'smtp.user': 'user',
  'smtp.password': 'pass',
  'smtp.from': 'noreply@test.it',
  'brand.name': 'Comune Test',
  'retention.maxDays': 90,
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };

describe('EmailStrategy', () => {
  let strategy: EmailStrategy;

  beforeEach(async () => {
    mockSendMail.mockClear();
    mockCreateTransport.mockClear();
    mockSendMail.mockResolvedValue({ messageId: 'msg-001', accepted: ['mario@example.com'] });

    const module = await Test.createTestingModule({
      providers: [
        EmailStrategy,
        { provide: ConfigService, useValue: mockConfig },
        { provide: AppSettingsService, useValue: mockSettings },
      ],
    }).compile();

    strategy = module.get(EmailStrategy);
  });

  it('is defined with channel EMAIL', () => {
    expect(strategy).toBeDefined();
    expect(strategy.channel).toBe('EMAIL');
  });

  it('send() chiama nodemailer con email del recipient', async () => {
    const recipient = {
      id: 'r1',
      email: 'mario@example.com',
      pec: null,
      fullName: 'Mario Rossi',
      codiceFiscale: 'RSSMRA85M01H501Z',
    };
    const campaign = {
      id: 'c1',
      name: 'TARI 2024',
      channelConfig: { subject: 'Avviso {{fullName}}', body: 'CF: {{codiceFiscale}}' },
    };

    const result = await strategy.send(recipient as never, campaign as never);

    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'mario@example.com',
        subject: 'Avviso Mario Rossi',
        text: 'CF: RSSMRA85M01H501Z',
      }),
    );
    expect(result.messageId).toBe('msg-001');
  });

  it('send() lancia BadRequestException se recipient.email è null', async () => {
    const recipient = { id: 'r2', email: null, fullName: 'Luca', codiceFiscale: 'CF2' };
    const campaign = { channelConfig: { subject: 'S', body: 'B' } };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow(
      'Recipient non ha indirizzo email',
    );
  });

  it('should propagate nodemailer error', async () => {
    const smtpError = new Error('SMTP connection refused');
    mockSendMail.mockRejectedValueOnce(smtpError);
    const recipient = {
      id: 'r3',
      email: 'ok@example.com',
      pec: null,
      fullName: 'Test User',
      codiceFiscale: 'TSTXXX00X00X123X',
    };
    const campaign = {
      id: 'c1',
      name: 'Test Campaign',
      channelConfig: { subject: 'Test', body: 'Body' },
    };

    await expect(strategy.send(recipient as never, campaign as never)).rejects.toThrow(
      'SMTP connection refused',
    );
  });
});
