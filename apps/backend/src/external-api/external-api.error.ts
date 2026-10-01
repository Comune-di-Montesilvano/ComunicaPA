export type ExternalErrorCode =
  | 'UNAUTHORIZED'
  | 'VALIDATION_ERROR'
  | 'CHANNEL_INACTIVE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'ATTACHMENT_INVALID'
  | 'LAUNCH_BLOCKED'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export interface ValidationIssue {
  field: string;
  message: string;
  allowed?: string[];
}

/** Errore di dominio dell'API esterna: il filtro lo traduce 1:1 nel body `{ success:false, error }` (sempre HTTP 200). */
export class ExternalApiError extends Error {
  constructor(
    readonly code: ExternalErrorCode,
    message: string,
    readonly details?: ValidationIssue[],
  ) {
    super(message);
    this.name = 'ExternalApiError';
  }
}
