import * as Sentry from '@sentry/node';

/**
 * Wrapper su Sentry.captureException che è no-op se l'SDK non è stato
 * inizializzato (nessuna SENTRY_DSN_BACKEND in .env — default dev locale).
 * Unico punto da usare in tutto il backend per riportare eccezioni a
 * GlitchTip: mai chiamare Sentry.captureException direttamente altrove.
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!Sentry.getClient()) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
}
