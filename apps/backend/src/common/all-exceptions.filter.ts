import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { captureException } from './sentry.util';

/**
 * Filtro globale di ultima istanza — replica ESATTAMENTE il comportamento
 * di default di Nest (stesso status/body per HttpException e per errori
 * generici), aggiungendo la segnalazione a Sentry/GlitchTip e il logging
 * dei generic error (non-HttpException) come fa di default Nest.
 * Ha precedenza più bassa dei filtri scoped via @UseFilters (es.
 * ExternalApiExceptionFilter su external-api/*), che restano intoccati.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    captureException(exception);

    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    // Log generic errors (non-HttpException) per preservare il comportamento
    // di debug del default Nest BaseExceptionFilter
    if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
    } else {
      this.logger.error(String(exception));
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
    });
  }
}
