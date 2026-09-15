/**
 * 11 cifre numeriche = Partita IVA/CF persona giuridica (stesso formato),
 * 16 alfanumerici = CF persona fisica — solo classificazione di FORMATO, un
 * solo punto di verità, riusato da DomicilioService e InadVerifyBulkService.
 *
 * ATTENZIONE: Partita IVA e Codice Fiscale persona giuridica coincidono per
 * la maggior parte delle imprese, ma NON sempre (es. enti pubblici,
 * cooperative sociali, soggetti con CF diverso dalla PIVA) — Registro
 * Imprese (`RegistroImpreseService.dettaglioImpresa`) interroga SEMPRE per
 * Codice Fiscale (endpoint `/dettaglio/codicefiscale`), mai per Partita IVA.
 * Se l'operatore inserisce una PIVA che per quel soggetto differisce dal CF,
 * la ricerca non trova nulla — non è un bug, va ripetuta con il CF reale.
 */
export function isPartitaIva(value: string): boolean {
  return /^\d{11}$/.test(value.trim());
}
