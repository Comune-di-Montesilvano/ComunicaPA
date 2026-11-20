import * as Sentry from '@sentry/node';

/**
 * Wrapper su Sentry.captureException che è no-op se l'SDK non è stato
 * inizializzato (nessuna SENTRY_DSN_BACKEND in .env — default dev locale).
 * Unico punto da usare in tutto il backend per riportare eccezioni a
 * GlitchTip: mai chiamare Sentry.captureException direttamente altrove.
 *
 * Bug reale verificato dal vivo (E2E contro GlitchTip reale, non solo unit
 * test): senza un flush esplicito, un errore reale catturato durante una
 * richiesta HTTP in un processo Node long-running NON viene mai inviato —
 * silenzioso, nessun errore, nessun log SDK. Ogni evento arrivato durante il
 * debug aveva un flush/close esplicito a monte (script one-off) o un crash
 * imminente del processo (integrazione OnUncaughtException, che flusha da
 * sola prima di uscire). Fix: `Sentry.flush()` fire-and-forget subito dopo
 * captureException — mai await qui, bloccherebbe la risposta HTTP
 * all'utente (questa funzione è chiamata da AllExceptionsFilter.catch()
 * PRIMA di super.catch(), che scrive la risposta).
 */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!Sentry.getClient()) return;
  Sentry.captureException(error, context ? { extra: context } : undefined);
  void Sentry.flush(2000).catch(() => {
    /* best-effort: un flush fallito non deve far crashare l'handler */
  });
}
