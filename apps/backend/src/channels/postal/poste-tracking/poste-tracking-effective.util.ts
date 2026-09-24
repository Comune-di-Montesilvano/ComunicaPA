import type { PostalPosteTracking, PosteTrackingMovement, PosteTrackingStatus } from '../../../entities/postal-poste-tracking.entity.js';
import { lastMovement } from './poste-tracking-mapping.util.js';

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

/**
 * Bucket sintetico di stato consegna (stesso pattern di NonTracciato/
 * AppIoSostituito/DirottatoAPec): GlobalCom dice NonConsegnato, Poste dice
 * consegnato. Unico punto di verità per breakdown, filtri, ricerca e CSV.
 */
export const POSTE_DELIVERED_BUCKET = 'ConsegnatoVerificaPoste';

export function isPosteDeliveredOverride(postalStatus: string | null | undefined, posteStatus: string | null | undefined): boolean {
  return postalStatus === 'NonConsegnato' && posteStatus === 'delivered';
}

/** Stesso predicato in SQL, su un alias di notification_attempts che espone id e postal_status. */
export function posteDeliveredSql(alias: string): string {
  return `(${alias}.postal_status = 'NonConsegnato' AND EXISTS (SELECT 1 FROM postal_poste_tracking ppt WHERE ppt.attempt_id = ${alias}.id AND ppt.status = 'delivered'))`;
}

export function posteVerificationLabel(v: { status: string; checkCount: number } | null | undefined): string {
  if (!v) return '';
  switch (v.status) {
    case 'delivered': return 'Consegnato';
    case 'returned': return 'Restituito al mittente';
    case 'pending': return `In verifica (${v.checkCount}/${POSTE_MAX_CHECKS})`;
    case 'gave_up': return 'Verifica esaurita';
    default: return v.status;
  }
}

export function formatLastMovement(movements: PosteTrackingMovement[] | null | undefined): string {
  const last = lastMovement(movements ?? []);
  if (!last) return '';
  const when = last.at ? new Date(last.at).toLocaleString('it-IT', { timeZone: 'Europe/Rome' }) : '';
  return [last.luogo, when].filter(Boolean).join(' ');
}
