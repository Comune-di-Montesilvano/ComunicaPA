/**
 * Mirror backend delle label italiane già in SEND_STATUS_META
 * (apps/frontend-admin/src/App.tsx) — stesse 10 chiavi (PAID escluso,
 * deprecato in NotificationStatusV26).
 */
const SEND_STATUS_LABELS: Record<string, string> = {
  IN_VALIDATION: 'In validazione',
  ACCEPTED: 'Accettata da SEND',
  REFUSED: 'Rifiutata',
  DELIVERING: 'In consegna',
  DELIVERED: 'Consegnata',
  VIEWED: 'Letta dal destinatario',
  EFFECTIVE_DATE: 'Perfezionata per decorrenza termini',
  UNREACHABLE: 'Destinatario irreperibile',
  CANCELLED: 'Annullata',
  RETURNED_TO_SENDER: 'Restituita al mittente',
};

export function sendStatusLabel(status: string | null): string {
  if (!status) return 'In attesa accettazione';
  return SEND_STATUS_LABELS[status] ?? status;
}

const DIGITAL_DOMICILE_TYPE_LABELS: Record<string, string> = {
  PEC: 'PEC',
  REM: 'REM',
  SERCQ: 'SERCQ',
  SMS: 'SMS',
  EMAIL: 'Email',
  APPIO: 'App IO',
  CARTACEO: 'Raccomandata cartacea',
};

export function digitalDomicileTypeLabel(type: string | null): string {
  if (!type) return '';
  return DIGITAL_DOMICILE_TYPE_LABELS[type] ?? type;
}

/** Ordine e intestazioni delle colonne data per il CSV "Storico" (PAID escluso, deprecato). */
export const SEND_STATUS_HISTORY_COLUMNS: Array<{ status: string; header: string }> = [
  { status: 'IN_VALIDATION', header: 'Data In Validazione' },
  { status: 'ACCEPTED', header: 'Data Accettazione' },
  { status: 'REFUSED', header: 'Data Rifiuto' },
  { status: 'DELIVERING', header: 'Data In Consegna' },
  { status: 'DELIVERED', header: 'Data Consegna' },
  { status: 'VIEWED', header: 'Data Visualizzazione' },
  { status: 'EFFECTIVE_DATE', header: 'Data Perfezionamento' },
  { status: 'UNREACHABLE', header: 'Data Irreperibilità' },
  { status: 'CANCELLED', header: 'Data Annullamento' },
  { status: 'RETURNED_TO_SENDER', header: 'Data Restituzione al Mittente' },
];
