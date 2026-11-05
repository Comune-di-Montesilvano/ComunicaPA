/**
 * Data con valore legale di avvenuta notifica SEND (perfezionamento): la
 * prima tra presa visione (VIEWED) e decorrenza termini (EFFECTIVE_DATE),
 * dalla storia stati PN (`notificationStatusHistory`, copiata su
 * `NotificationAttempt.sendStatusHistory`). null se non ancora perfezionata.
 */
export function sendLegalDateOf(history: Array<{ status: string; activeFrom: string }> | null | undefined): string | null {
  const dates = (history ?? [])
    .filter((h) => (h.status === 'VIEWED' || h.status === 'EFFECTIVE_DATE') && h.activeFrom)
    .map((h) => h.activeFrom);
  if (dates.length === 0) return null;
  return dates.reduce((min, d) => (new Date(d).getTime() < new Date(min).getTime() ? d : min));
}

/**
 * Data legale di notifica per l'ente: messa a disposizione del documento su
 * SEND (art. 26, comma 9, lett. a, D.L. 76/2020); impedisce le decadenze e
 * interrompe la prescrizione (comma 10). = stato ACCEPTED dello storico PN,
 * attestata dall'attestazione "notifica presa in carico" (fa fede l'ora di
 * quella, pochi minuti dopo). null se mai accettata o annullata.
 */
export function sendEntityLegalDateOf(history: Array<{ status: string; activeFrom: string }> | null | undefined): string | null {
  const h = history ?? [];
  if (h.some((e) => e.status === 'CANCELLED')) return null;
  return h.find((e) => e.status === 'ACCEPTED' && e.activeFrom)?.activeFrom ?? null;
}

/** Giorni per cui SEND mostra i documenti notificati dopo la data legale (AAR e attestazioni: 10 anni). */
export const SEND_DOCUMENTS_RETENTION_DAYS = 120;

/**
 * Fino a quando i documenti notificati restano consultabili su SEND: data
 * legale + 120 giorni. null se la notifica non ha ancora valore legale.
 */
export function sendDocumentsAvailableUntil(history: Array<{ status: string; activeFrom: string }> | null | undefined): Date | null {
  const legalDate = sendLegalDateOf(history);
  if (!legalDate) return null;
  return new Date(new Date(legalDate).getTime() + SEND_DOCUMENTS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}
