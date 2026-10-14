export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface SignatureJobStatus {
  status: string;
  totalRows: number;
  validCount: number;
  invalidCount: number;
  errorMessage: string | null;
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
