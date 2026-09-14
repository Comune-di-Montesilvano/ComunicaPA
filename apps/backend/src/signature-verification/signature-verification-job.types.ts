export const SIGNATURE_VERIFICATION_QUEUE = 'signature-verification-jobs';

export interface SignatureVerificationQueueJobData {
  jobId: string;
  campaignId: string;
}
