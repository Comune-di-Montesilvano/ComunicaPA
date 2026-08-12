export class RegistroImpreseRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds?: number) {
    super(`Registro Imprese: limite richieste superato${retryAfterSeconds ? ` (riprova tra ${retryAfterSeconds}s)` : ''}`);
    this.name = 'RegistroImpreseRateLimitError';
  }
}
