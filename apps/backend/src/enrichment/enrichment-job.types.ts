export const ENRICHMENT_QUEUE = 'enrichment-jobs';

export interface EnrichmentQueueJobData {
  jobId: string;
}

export const CONVERT_CAMPAIGN_JOB_NAME = 'convert-campaign';

export interface ConvertCampaignQueueJobData {
  jobId: string;
  name: string;
  channelType: 'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL';
  createdBy: string;
}

export const MERGE_BATCH_JOB_NAME = 'merge-batch';

export interface MergeBatchQueueJobData {
  jobId: string;
  batchId: string;
  zipPaths: string[];
  zipFilenames: string[];
}
