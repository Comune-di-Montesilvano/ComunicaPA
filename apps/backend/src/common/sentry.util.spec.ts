import * as Sentry from '@sentry/node';
import { captureException } from './sentry.util';

jest.mock('@sentry/node', () => ({
  getClient: jest.fn(),
  captureException: jest.fn(),
  flush: jest.fn(),
}));

describe('captureException', () => {
  beforeEach(() => {
    (Sentry.flush as jest.Mock).mockResolvedValue(true);
  });
  afterEach(() => jest.clearAllMocks());

  it('non chiama Sentry.captureException se il client non è inizializzato', () => {
    (Sentry.getClient as jest.Mock).mockReturnValue(undefined);
    captureException(new Error('boom'));
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('chiama Sentry.captureException se il client è inizializzato', () => {
    (Sentry.getClient as jest.Mock).mockReturnValue({});
    const err = new Error('boom');
    captureException(err);
    expect(Sentry.captureException).toHaveBeenCalledWith(err, undefined);
  });

  it('passa il context come extra quando fornito', () => {
    (Sentry.getClient as jest.Mock).mockReturnValue({});
    const err = new Error('boom');
    captureException(err, { attemptId: 'abc-123' });
    expect(Sentry.captureException).toHaveBeenCalledWith(err, { extra: { attemptId: 'abc-123' } });
  });

  it('flusha dopo aver catturato — bug reale: senza flush esplicito un evento reale non arriva mai a GlitchTip da un processo long-running (verificato E2E)', () => {
    (Sentry.getClient as jest.Mock).mockReturnValue({});
    captureException(new Error('boom'));
    expect(Sentry.flush).toHaveBeenCalledWith(2000);
  });

  it('un flush fallito non fa propagare eccezioni al chiamante', () => {
    (Sentry.getClient as jest.Mock).mockReturnValue({});
    (Sentry.flush as jest.Mock).mockRejectedValue(new Error('rete giù'));
    expect(() => captureException(new Error('boom'))).not.toThrow();
  });
});
