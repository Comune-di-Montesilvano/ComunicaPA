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

// Struttura del CF persona fisica (DM 23/12/1976): cognome(3) nome(3)
// anno(2) mese(1) giorno(2) comune(4) controllo(1). Le cifre possono essere
// sostituite dalle lettere di omocodia L-V (0-9), mai altre lettere.
const CF_STRUCTURE = /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/;

// Valori delle posizioni dispari (1ª, 3ª, ... in numerazione da 1), indicizzati
// per cifra (0-9) e per lettera (A-Z): stessa tabella per la cifra e la
// lettera corrispondente (0=A, 1=B, ...).
const CF_ODD_VALUES = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23];

function cfCharIndex(ch: string): number {
  const code = ch.charCodeAt(0);
  return code >= 48 && code <= 57 ? code - 48 : code - 65;
}

/**
 * CF persona fisica formalmente valido: struttura (con omocodia) e carattere
 * di controllo. Solo validità FORMALE — non dice se il CF è stato davvero
 * attribuito (per quello serve ANPR/Anagrafe Tributaria).
 */
export function isValidCodiceFiscale(value: string): boolean {
  const cf = value.trim().toUpperCase();
  if (!CF_STRUCTURE.test(cf)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const idx = cfCharIndex(cf[i]);
    // i parte da 0: i pari = posizione dispari in numerazione da 1.
    sum += i % 2 === 0 ? CF_ODD_VALUES[idx] : idx;
  }
  return String.fromCharCode(65 + (sum % 26)) === cf[15];
}

/**
 * Partita IVA / CF numerico (11 cifre) con cifra di controllo valida
 * (algoritmo di Luhn nella variante dell'Anagrafe Tributaria). Vale anche
 * per i CF numerici delle persone giuridiche e per i CF provvisori.
 */
export function isValidPartitaIva(value: string): boolean {
  const v = value.trim();
  if (!/^\d{11}$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let d = v.charCodeAt(i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === v.charCodeAt(10) - 48;
}

export type TaxIdCheck =
  | { kind: 'cf'; value: string }
  | { kind: 'piva'; value: string }
  | { kind: 'invalid'; value: string; error: string };

/**
 * Classifica e valida un valore della colonna CF/PIVA di un tracciato:
 * 16 caratteri = CF persona fisica, 11 cifre = Partita IVA/CF numerico.
 * Un valore che non passa il controllo formale non va mai mandato ai
 * servizi esterni (INAD, App IO, Registro Imprese, ANPR): l'errore finisce
 * nel report per la riga.
 */
export function checkTaxId(raw: string): TaxIdCheck {
  const value = raw.trim().toUpperCase();
  if (value === '') return { kind: 'invalid', value, error: 'codice fiscale/partita IVA mancante' };
  if (value.length === 16) {
    return isValidCodiceFiscale(value)
      ? { kind: 'cf', value }
      : { kind: 'invalid', value, error: 'codice fiscale non valido (struttura o carattere di controllo errati)' };
  }
  if (/^\d{11}$/.test(value)) {
    return isValidPartitaIva(value)
      ? { kind: 'piva', value }
      : { kind: 'invalid', value, error: 'partita IVA non valida (cifra di controllo errata)' };
  }
  if (/^\d{1,10}$/.test(value)) {
    return { kind: 'invalid', value, error: 'partita IVA con meno di 11 cifre (zeri iniziali persi, es. aprendo il file con Excel?)' };
  }
  return { kind: 'invalid', value, error: 'formato non valido (attesi 16 caratteri per il codice fiscale o 11 cifre per la partita IVA)' };
}
