import type { PostalPosteTracking, PosteTrackingMovement, PosteTrackingStatus } from '../../../entities/postal-poste-tracking.entity.js';
import { lastMovement } from './poste-tracking-mapping.util.js';

/** Finestra di verifica: 90 giorni dalla data della notifica (non 90 risposte). */
export const POSTE_TRACKING_DAYS = 90;

export interface PosteVerificationDto {
  status: PosteTrackingStatus;
  trackingCode: string;
  checkCount: number;
  /** Fine finestra di verifica (data notifica + 90 giorni). */
  trackingUntil: string | null;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  /** Data esito Poste (consegna o ritorno al mittente). */
  outcomeAt: string | null;
  /** Ultimo stato visto su Poste, qualunque sia (anche intermedio). */
  summary: string | null;
  movements: PosteTrackingMovement[];
}

export function toPosteVerificationDto(row: PostalPosteTracking): PosteVerificationDto {
  return {
    status: row.status,
    trackingCode: row.trackingCode,
    checkCount: row.checkCount,
    trackingUntil: row.trackingUntil ? row.trackingUntil.toISOString() : null,
    nextCheckAt: row.nextCheckAt ? row.nextCheckAt.toISOString() : null,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    lastError: row.lastError,
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    outcomeAt: row.outcomeAt ? row.outcomeAt.toISOString() : null,
    summary: posteSummaryOf(row),
    movements: row.movements ?? [],
  };
}

/**
 * Bucket sintetico di stato consegna (stesso pattern di NonTracciato/
 * AppIoSostituito/DirottatoAPec): GlobalCom dice NonConsegnato, Poste dice
 * consegnato. Unico punto di verità per breakdown, filtri, ricerca e CSV.
 */
export const POSTE_DELIVERED_BUCKET = 'ConsegnatoVerificaPoste';

/** Poste dice consegnata mentre GlobalCom dice qualunque cosa diversa da consegnato (NonConsegnato o invio fermo). */
export function isPosteDeliveredOverride(postalStatus: string | null | undefined, posteStatus: string | null | undefined): boolean {
  return posteStatus === 'delivered' && postalStatus !== 'Consegnato';
}

/** Stesso predicato in SQL, su un alias di notification_attempts che espone id e postal_status. */
export function posteDeliveredSql(alias: string): string {
  return `(COALESCE(${alias}.postal_status, '') <> 'Consegnato' AND EXISTS (SELECT 1 FROM postal_poste_tracking ppt WHERE ppt.attempt_id = ${alias}.id AND ppt.status = 'delivered'))`;
}

function formatDay(d: string | Date): string {
  return new Date(d).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' });
}

export function posteVerificationLabel(v: { status: string; trackingUntil?: string | Date | null } | null | undefined): string {
  if (!v) return '';
  switch (v.status) {
    case 'delivered': return 'Consegnato';
    case 'returned': return 'Restituito al mittente';
    case 'pending': return v.trackingUntil ? `In verifica fino al ${formatDay(v.trackingUntil)}` : 'In verifica';
    case 'gave_up': return `Verifica esaurita (${POSTE_TRACKING_DAYS} giorni)`;
    default: return v.status;
  }
}

/**
 * Ultimo stato visto su Poste, qualunque sia: frase di sintesi di Poste
 * (`sintesiStato`), altrimenti l'ultimo movimento, altrimenti "nessuna
 * informazione" se Poste non conosce il codice. null se mai risposto.
 */
export function posteSummaryOf(row: Pick<PostalPosteTracking, 'lastResponse' | 'movements' | 'posteEsitoRicerca'>): string | null {
  const sintesi = row.lastResponse?.['sintesiStato'];
  if (typeof sintesi === 'string' && sintesi.trim()) return sintesi.trim();
  const last = lastMovement(row.movements ?? []);
  if (last) {
    const when = last.at ? new Date(last.at).toLocaleString('it-IT', { timeZone: 'Europe/Rome' }) : '';
    return [last.statoLavorazione, last.luogo, when].filter(Boolean).join(' · ');
  }
  if (row.posteEsitoRicerca === '1') return 'Nessuna informazione su Poste per questo codice';
  return null;
}

export function formatLastMovement(movements: PosteTrackingMovement[] | null | undefined): string {
  const last = lastMovement(movements ?? []);
  if (!last) return '';
  const when = last.at ? new Date(last.at).toLocaleString('it-IT', { timeZone: 'Europe/Rome' }) : '';
  return [last.luogo, when].filter(Boolean).join(' ');
}
