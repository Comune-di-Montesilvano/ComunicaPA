// apps/frontend-admin/src/components/legal-attention/types.ts
export type LegalAttentionKind = 'blocking' | 'stale';

export interface LegalAttentionSummaryItem {
  campaignId: string;
  name: string;
  channelType: string;
  createdBy: string;
  createdByDisplayName: string;
  blockingCount: number;
  staleCount: number;
}

export interface LegalAttentionItem {
  recipientId: string;
  fullName: string | null;
  codiceFiscale: string;
  kind: LegalAttentionKind;
  reason: string;
  firstAttemptAt: string | null;
  iun: string | null;
  postalCode: string | null;
  lastReview: { action: string; snoozedUntil: string | null; note: string | null; createdBy: string; createdAt: string } | null;
}

export interface ApplyReviewsResult {
  applied: number;
  skipped: Array<{ recipientId: string; reason: string }>;
}

export type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export const KIND_LABELS: Record<LegalAttentionKind, string> = {
  blocking: 'Esito bloccante',
  stale: 'Ferma da oltre 45 giorni',
};
