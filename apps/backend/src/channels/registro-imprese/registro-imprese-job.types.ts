export const REGISTRO_IMPRESE_QUEUE = 'registro-imprese-verify';
export const VERIFY_PIVA_JOB_NAME = 'verify-piva';

export interface RegistroImpreseVerifyJobData {
  jobId: string;
  partitaIva: string;
}
