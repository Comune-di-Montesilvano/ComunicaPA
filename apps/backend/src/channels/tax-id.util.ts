/**
 * 11 cifre numeriche = Partita IVA, 16 alfanumerici = CF persona fisica.
 * Nessun caso ambiguo noto — un solo punto di verità, riusato da
 * DomicilioService e InadVerifyBulkService.
 */
export function isPartitaIva(value: string): boolean {
  return /^\d{11}$/.test(value.trim());
}
