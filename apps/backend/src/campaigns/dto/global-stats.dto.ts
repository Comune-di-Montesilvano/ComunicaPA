export interface GlobalStatsTotalsDto {
  totalRecipients: number;
  totalSent: number;
  totalFailed: number;
  totalDownloaded: number;
  downloadPercentage: number;
}

export interface MonthlyTrendPointDto {
  month: string;
  sent: number;
  downloaded: number;
}

export interface ChannelTotalDto {
  channel: string;
  sent: number;
}

export interface DownloadChannelTotalDto {
  channel: string;
  count: number;
}

export interface CampaignLeaderboardEntryDto {
  campaignId: string;
  campaignName: string;
  totalRecipients: number;
  downloadPercentage: number;
}

export interface GlobalStatsDto {
  totals: GlobalStatsTotalsDto;
  monthlyTrend: MonthlyTrendPointDto[];
  channelTotals: ChannelTotalDto[];
  downloadChannelTotals: DownloadChannelTotalDto[];
  campaignLeaderboard: CampaignLeaderboardEntryDto[];
  neverDownloadedCount: number;
}
