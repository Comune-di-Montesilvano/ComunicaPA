export const REMOTE_SIGN_QUEUE = 'remote-sign-jobs';

export interface RemoteSignQueueJobData {
  jobId: string;
  campaignId: string;
  sessionId: string;
  user: string;
  /** Cifrata enc:v1: (AES-256-GCM, chiave dei secret di settings): mai in chiaro su Redis. */
  passwordEnc: string;
}
