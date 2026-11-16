/**
 * Messaggio leggibile da un valore catturato in un `catch` (tipo `unknown`): `message` di un
 * Error o di un oggetto che ne ha uno (errori di librerie non derivati da Error). Senza un
 * messaggio non vuoto restituisce `fallback` se indicato, altrimenti la conversione a stringa.
 */
export function errorMessage(err: unknown, fallback?: string): string {
  let msg: string | undefined;
  if (err instanceof Error) msg = err.message;
  else if (typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string') {
    msg = (err as { message: string }).message;
  }
  if (msg) return msg;
  return fallback ?? String(err);
}
