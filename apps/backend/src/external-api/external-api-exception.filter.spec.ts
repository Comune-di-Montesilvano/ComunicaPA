import { ArgumentsHost, BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ExternalApiExceptionFilter } from './external-api-exception.filter';

function makeHost() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('ExternalApiExceptionFilter', () => {
  const filter = new ExternalApiExceptionFilter();

  it('normalizza UnauthorizedException a 200 con code UNAUTHORIZED', () => {
    const { host, status, json } = makeHost();
    filter.catch(new UnauthorizedException('key mancante'), host);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: false, error: { code: 'UNAUTHORIZED', message: 'key mancante' } });
  });

  it('normalizza NotFoundException a 200 con code NOT_FOUND', () => {
    const { host, status, json } = makeHost();
    filter.catch(new NotFoundException('non trovato'), host);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: false, error: { code: 'NOT_FOUND', message: 'non trovato' } });
  });

  it('normalizza BadRequestException (validazione class-validator, array di messaggi) a VALIDATION_ERROR', () => {
    const { host, status, json } = makeHost();
    filter.catch(new BadRequestException(['subject troppo corto', 'cf non valido']), host);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validazione fallita', details: ['subject troppo corto', 'cf non valido'] },
    });
  });

  it('normalizza un errore generico non-HttpException a INTERNAL_ERROR senza esporre lo stack', () => {
    const { host, status, json } = makeHost();
    filter.catch(new Error('boom interno con dettagli sensibili'), host);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Errore interno' } });
  });

  it('normalizza ForbiddenException (generico HttpException non coperto) a 200 con code LAUNCH_BLOCKED', () => {
    const { host, status, json } = makeHost();
    filter.catch(new ForbiddenException('accesso negato'), host);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: false, error: { code: 'LAUNCH_BLOCKED', message: 'accesso negato' } });
  });
});
