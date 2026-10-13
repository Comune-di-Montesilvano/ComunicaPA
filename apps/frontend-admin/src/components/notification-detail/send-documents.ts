// Etichette dei documenti SEND nel dettaglio notifica (backoffice).
// Gli atti generati da PN sono "attestazioni opponibili a terzi" e vanno
// chiamati così, come su notifichedigitali.it. Sotto ANALOG_DELIVERY PN mette
// documenti diversi (copia conforme dell'AAR spedito, cartolina AR, plico
// restituito...): il backend passa il documentType letto dalla timeline, unico
// dato che li distingue.

export interface SendDocumentItem {
  legalFactId: string;
  category: string;
  documentType?: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  SENDER_ACK: 'Attestazione opponibile a terzi: notifica presa in carico',
  AAR: 'Avviso di avvenuta ricezione (AAR)',
  DIGITAL_DELIVERY: 'Attestazione opponibile a terzi: notifica digitale',
  RECIPIENT_ACCESS: 'Attestazione opponibile a terzi: avvenuto accesso',
  ANALOG_FAILURE_DELIVERY: 'Attestazione opponibile a terzi: mancato recapito',
  NOTIFICATION_CANCELLED: 'Attestazione opponibile a terzi: notifica annullata',
  PEC_RECEIPT: 'Ricevuta PEC',
};

const ANALOG_DOCUMENT_LABELS: Record<string, string> = {
  'Copia Conforme AAR': "Copia conforme dell'avviso spedito (AAR)",
  AR: 'Cartolina AR firmata (ricevuta di ritorno)',
  Plico: 'Plico restituito (destinatario irreperibile)',
  CAD: 'Comunicazione di avvenuto deposito (CAD)',
  ARCAD: 'Cartolina AR della comunicazione di avvenuto deposito',
  '23L': 'Avviso di deposito (23L)',
  Indagine: "Esito dell'indagine sull'indirizzo",
};

export function sendDocumentLabel(item: SendDocumentItem): string {
  if (item.category === 'ANALOG_DELIVERY') {
    if (!item.documentType) return 'Documento della consegna cartacea';
    return ANALOG_DOCUMENT_LABELS[item.documentType] ?? `Documento della consegna cartacea (${item.documentType})`;
  }
  return CATEGORY_LABELS[item.category] ?? item.category;
}
