import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { captureException } from './sentry.util';

/**
 * Filtro globale di ultima istanza — ESTENDE `BaseExceptionFilter` di Nest
 * invece di reimplementarne il comportamento a mano, per ereditare
 * automaticamente ogni caso limite già gestito dal default Nest (status/body
 * per HttpException, errori non-HttpException con shape `http-errors` come
 * `PayloadTooLargeError` dal body-parser, `isHeadersSent` per handler
 * `@Res()`/SSE che hanno già inviato risposta prima di lanciare...).
 * Aggiunge solo la segnalazione a Sentry/GlitchTip — SOLO per errori reali
 * (non-HttpException, o HttpException con status >= 500): un 4xx normale
 * (401/400/404 — token scaduti, validazioni, scan bot su rotte pubbliche)
 * non è un errore da riportare, stessa filosofia di `ExternalApiExceptionFilter`
 * (che riporta solo INTERNAL_ERROR).
 * Ha precedenza più bassa dei filtri scoped via @UseFilters (es.
 * ExternalApiExceptionFilter su external-api/*), che restano intoccati.
 */
@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    const isServerError = !(exception instanceof HttpException) || exception.getStatus() >= 500;
    if (isServerError) {
      captureException(exception);
    }
    super.catch(exception, host);
  }
}
