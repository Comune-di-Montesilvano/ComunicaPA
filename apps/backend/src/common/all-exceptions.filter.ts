import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { captureException } from './sentry.util';

/**
 * Filtro globale di ultima istanza — replica ESATTAMENTE il comportamento
 * di default di Nest (stesso status/body per HttpException e per errori
 * generici), aggiungendo solo la segnalazione a Sentry/GlitchTip. Ha
 * precedenza più bassa dei filtri scoped via @UseFilters (es.
 * ExternalApiExceptionFilter su external-api/*), che restano intoccati.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    captureException(exception);

    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
