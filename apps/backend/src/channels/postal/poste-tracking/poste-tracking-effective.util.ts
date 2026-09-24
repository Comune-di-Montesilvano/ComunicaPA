import type { PostalPosteTracking, PosteTrackingMovement, PosteTrackingStatus } from '../../../entities/postal-poste-tracking.entity.js';

/** Allineato a MAX_POSTE_CHECKS del servizio (definito qui per evitare import circolare util → service). */
export const POSTE_MAX_CHECKS = 90;

export interface PosteVerificationDto {
  status: PosteTrackingStatus;
  trackingCode: string;
  checkCount: number;
  maxChecks: number;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  movements: PosteTrackingMovement[];
}

export function toPosteVerificationDto(row: PostalPosteTracking): PosteVerificationDto {
  return {
    status: row.status,
    trackingCode: row.trackingCode,
    checkCount: row.checkCount,
    maxChecks: POSTE_MAX_CHECKS,
    nextCheckAt: row.nextCheckAt ? row.nextCheckAt.toISOString() : null,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    lastError: row.lastError,
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    movements: row.movements ?? [],
  };
}
