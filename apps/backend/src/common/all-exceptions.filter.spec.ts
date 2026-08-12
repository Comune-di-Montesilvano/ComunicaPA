import { ArgumentsHost, NotFoundException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import * as sentryUtil from './sentry.util';

jest.mock('./sentry.util', () => ({ captureException: jest.fn() }));

function makeHost() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const response = { status };
  const getResponse = () => response;
  const getRequest = () => ({});
  const host = {
    switchToHttp: () => ({ getResponse, getRequest }),
    // BaseExceptionFilter legge la response reale con getArgByIndex(1),
    // non tramite switchToHttp().getResponse() — entrambe devono tornare
    // lo stesso oggetto response.
    getArgByIndex: (index: number) => (index === 1 ? response : undefined),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

// Fake HttpAdapter minimale, sufficiente per BaseExceptionFilter — non
// bootiamo l'intera app Nest qui, solo il comportamento del filtro.
function makeHttpAdapter() {
  return {
    reply: jest.fn((response: { status: (code: number) => { json: (body: unknown) => void } }, body: unknown, statusCode: number) => {
      response.status(statusCode).json(body);
    }),
    end: jest.fn(),
    isHeadersSent: jest.fn(() => false),
    getRequestUrl: jest.fn(() => '/test'),
    getRequestMethod: jest.fn(() => 'GET'),
  };
}

describe('AllExceptionsFilter', () => {
  afterEach(() => jest.clearAllMocks());

  it('chiama captureException per un errore generico (non-HttpException)', () => {
    const adapter = makeHttpAdapter();
    const filter = new AllExceptionsFilter(adapter as never);
    const { host } = makeHost();
    const genericErr = new Error('boom');

    filter.catch(genericErr, host);

    expect(sentryUtil.captureException).toHaveBeenCalledWith(genericErr);
  });

  it('chiama captureException per una HttpException con status >= 500', () => {
    const adapter = makeHttpAdapter();
    const filter = new AllExceptionsFilter(adapter as never);
    const { host } = makeHost();
    const serverErr = new NotFoundException('x');
    jest.spyOn(serverErr, 'getStatus').mockReturnValue(500);

    filter.catch(serverErr, host);

    expect(sentryUtil.captureException).toHaveBeenCalledWith(serverErr);
  });

  it('NON chiama captureException per una HttpException 4xx (es. NotFoundException)', () => {
    const adapter = makeHttpAdapter();
    const filter = new AllExceptionsFilter(adapter as never);
    const { host } = makeHost();

    filter.catch(new NotFoundException('destinatario non trovato'), host);

    expect(sentryUtil.captureException).not.toHaveBeenCalled();
  });

  it('non lancia e produce comunque una risposta tramite l\'adapter', () => {
    const adapter = makeHttpAdapter();
    const filter = new AllExceptionsFilter(adapter as never);
    const { host, status } = makeHost();

    expect(() => filter.catch(new Error('boom'), host)).not.toThrow();
    expect(status).toHaveBeenCalled();
  });
});
