import * as Sentry from '@sentry/node';
import { captureException } from './sentry.util';

jest.mock('@sentry/node', () => ({
  getClient: jest.fn(),
  captureException: jest.fn(),
}));

describe('captureException', () => {
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
});
