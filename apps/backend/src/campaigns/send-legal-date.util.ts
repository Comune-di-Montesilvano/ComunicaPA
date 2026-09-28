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
