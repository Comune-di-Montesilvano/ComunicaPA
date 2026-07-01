export function getEffectiveRetentionDays(
  campaign: { retentionDays: number | null },
  maxDays: number,
): number {
  if (campaign.retentionDays == null) return maxDays;
  return Math.min(campaign.retentionDays, maxDays);
}
