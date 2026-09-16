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

/**
 * Formato valido per CF persona fisica (16 alfanumerici) o PIVA/CF persona
 * giuridica (11 cifre) — stesso regex già in uso lato frontend (App.tsx,
 * isValidCfOrPiva locale, mai condivisa fino ad ora). Solo controllo di
 * FORMATO, nessun checksum — stesso principio di isPartitaIva sopra.
 */
export function isValidCfOrPiva(value: string): boolean {
  const v = value.trim();
  return /^[A-Z0-9]{16}$/i.test(v) || /^\d{11}$/.test(v);
}
