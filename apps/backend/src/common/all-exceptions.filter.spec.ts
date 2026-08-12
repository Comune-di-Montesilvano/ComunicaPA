import { ArgumentsHost, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import * as sentryUtil from './sentry.util';

jest.mock('./sentry.util', () => ({ captureException: jest.fn() }));

function makeHost() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = { switchToHttp: () => ({ getResponse: () => ({ status }) }) } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  afterEach(() => jest.clearAllMocks());

  it('per HttpException risponde con lo stesso status/body che Nest produrrebbe di default', () => {
    const { host, status, json } = makeHost();
    filter.catch(new NotFoundException('destinatario non trovato'), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith({ statusCode: HttpStatus.NOT_FOUND, message: 'destinatario non trovato', error: 'Not Found' });
  });

  it('per errore generico risponde 500 con body standard Nest', () => {
    const { host, status, json } = makeHost();
    filter.catch(new Error('boom'), host);
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({ statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' });
  });

  it('chiama sempre captureException, sia per HttpException che per errore generico', () => {
    const { host } = makeHost();
    const httpErr = new NotFoundException('x');
    const genericErr = new Error('boom');
    filter.catch(httpErr, host);
    filter.catch(genericErr, host);
    expect(sentryUtil.captureException).toHaveBeenNthCalledWith(1, httpErr);
    expect(sentryUtil.captureException).toHaveBeenNthCalledWith(2, genericErr);
  });

  it('per errore generico loga message e stack come default Nest', () => {
    const loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { host } = makeHost();
    const error = new Error('test boom');
    filter.catch(error, host);
    expect(loggerErrorSpy).toHaveBeenCalledWith(error.message, error.stack);
    loggerErrorSpy.mockRestore();
  });

  it('per errore non-Error (valore primitivo) loga il valore stringificato', () => {
    const loggerErrorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { host } = makeHost();
    filter.catch('errore primitivo', host);
    expect(loggerErrorSpy).toHaveBeenCalledWith('errore primitivo');
    loggerErrorSpy.mockRestore();
  });
});
