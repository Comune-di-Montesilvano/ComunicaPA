export interface CampaignStatsDto {
  campaignId: string;
  totalRecipients: number;
  totalSent: number;
  totalDownloaded: number;
  downloadPercentage: number;
  lastDownloadAt: Date | null;
}

export interface RecipientStatDto {
  id: string;
  fullName: string | null;
  codiceFiscale: string;
  email: string | null;
  pec: string | null;
  status: string;
  downloadCount: number;
  firstDownloadedAt: Date | null;
  lastDownloadedAt: Date | null;
  attachmentDeletedAt: Date | null;
}

export interface RecipientStatsPageDto {
  campaignId: string;
  page: number;
  pageSize: number;
  total: number;
  items: RecipientStatDto[];
}

export interface ChannelBreakdownDto {
  primaryOnly: number;
  both: number;
  appIoOnly: number;
  appIoDespitePrimaryFail: number;
  neither: number;
}

export interface DownloadCombinationDto {
  /** Canali da cui il destinatario ha scaricato (ordinati); [] = nessun download. */
  channels: string[];
  count: number;
}

export interface DownloadCombinationStatsDto {
  totalRecipients: number;
  combinations: DownloadCombinationDto[];
}

export interface FailureRowDto {
  recipientId: string;
  codiceFiscale: string;
  fullName: string | null;
  errorMessage: string | null;
  attemptNumber: number;
  lastAttemptAt: string;
}

export interface FailureGroupDto {
  errorMessage: string;
  count: number;
  recipientIds: string[];
}

export interface RetryBulkResultDto {
  requeued: number;
  failed: Array<{ recipientId: string; reason: string }>;
}

export interface DownloadReportRowDto {
  codiceFiscale: string;
  fullName: string | null;
  email: string | null;
  pec: string | null;
  status: string;
  downloadCount: number;
  lastDownloadedAt: string | null;
}
