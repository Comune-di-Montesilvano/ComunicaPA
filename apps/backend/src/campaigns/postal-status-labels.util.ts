/**
 * Mirror backend delle label italiane già in POSTAL_STATUS_META
 * (apps/frontend-admin/src/App.tsx) — stesse 14 chiavi dell'enum GBCStatus.
 */
const POSTAL_STATUS_LABELS: Record<string, string> = {
  FAILED: 'Fallito',
  Accettato: 'Accettato',
  Sospeso: 'Sospeso',
  Verificato: 'Verificato',
  Normalizzazione: 'Normalizzazione indirizzo',
  Inviato: 'Inviato a Poste',
  Elaborato: 'Elaborato',
  AttesaStampa: 'Attesa stampa',
  Confermato: 'Confermato',
  Rimandato: 'Rimandato (ritento)',
  Consegnato: 'Consegnato',
  NonConsegnato: 'Non consegnato',
  ConsegnaParziale: 'Consegna parziale',
  Errore: 'Errore',
  Eliminato: 'Eliminato',
};

export function postalStatusLabel(status: string | null): string {
  if (!status) return 'In corso';
  return POSTAL_STATUS_LABELS[status] ?? status;
}

/** Ordine e intestazioni delle colonne data per il CSV "Storico" (14 stati GBC). */
export const POSTAL_STATUS_HISTORY_COLUMNS: Array<{ status: string; header: string }> = [
  { status: 'Accettato', header: 'Data Accettato' },
  { status: 'Sospeso', header: 'Data Sospeso' },
  { status: 'Verificato', header: 'Data Verificato' },
  { status: 'Normalizzazione', header: 'Data Normalizzazione' },
  { status: 'Inviato', header: 'Data Inviato' },
  { status: 'Elaborato', header: 'Data Elaborato' },
  { status: 'AttesaStampa', header: 'Data Attesa Stampa' },
  { status: 'Confermato', header: 'Data Confermato' },
  { status: 'Rimandato', header: 'Data Rimandato' },
  { status: 'Consegnato', header: 'Data Consegnato' },
  { status: 'NonConsegnato', header: 'Data Non Consegnato' },
  { status: 'ConsegnaParziale', header: 'Data Consegna Parziale' },
  { status: 'Errore', header: 'Data Errore' },
  { status: 'Eliminato', header: 'Data Eliminato' },
];
