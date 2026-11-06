/**
 * Lunghezza massima di `subject` nella richiesta di notifica PN
 * (NewNotificationRequest). Errore reale: HTTP 400 PN_INVALID_BODY
 * "string ... is too long (length: 170, maximum allowed: 134)".
 */
export const SEND_SUBJECT_MAX = 134;

/** Messaggio d'errore se l'oggetto supera il limite PN, altrimenti null. */
export function sendSubjectTooLong(subject: string): string | null {
  return subject.length > SEND_SUBJECT_MAX
    ? `Oggetto SEND troppo lungo: ${subject.length} caratteri, SEND ne accetta al massimo ${SEND_SUBJECT_MAX}. Accorcia l'oggetto e invia di nuovo`
    : null;
}
