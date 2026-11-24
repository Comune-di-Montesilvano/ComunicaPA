export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface SignatureJobStatus {
  status: string;
  totalRows: number;
  validCount: number;
  invalidCount: number;
  errorMessage: string | null;
  required?: boolean;
  /** Allegati non validi raggruppati per file e motivo (i più frequenti, max 10). */
  invalidFiles?: SignatureInvalidFile[];
  /** Voci totali di invalidFiles prima del limite. */
  invalidFilesTotal?: number;
}

export interface SignatureInvalidFile {
  filename: string | null;
  reason: string;
  /** Destinatari che hanno questo allegato non valido. */
  recipients: number;
}

export interface RemoteSignStatus {
  status: 'queued' | 'processing' | 'done' | 'failed';
  totalFiles: number;
  signedCount: number;
  failedCount: number;
  errorKind: string | null;
  errorMessage: string | null;
  signerCn: string | null;
}

export const ARUBA_USER_STORAGE_KEY = 'comunicapa.arubaSignUser';
