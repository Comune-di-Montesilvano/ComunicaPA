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
