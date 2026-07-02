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
