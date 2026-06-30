import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PecStrategy } from './pec.strategy';

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}));

const mockConfig = {
  get: (key: string) => {
    const cfg: Record<string, unknown> = {
      'pec.host': 'pec.test',
      'pec.port': 587,
      'pec.secure': false,
      'pec.user': 'u',
      'pec.password': 'p',
      'pec.from': 'noreply@pec.test.it',
    };
    return cfg[key];
  },
};

describe('PecStrategy', () => {
  let strategy: PecStrategy;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: 'pec-001', accepted: ['luca@pec.it'] });

    const module = await Test.createTestingModule({
      providers: [PecStrategy, { provide: ConfigService, useValue: mockConfig }],
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
