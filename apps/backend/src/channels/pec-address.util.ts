/**
 * Confronto tra indirizzi PEC/email da fonti diverse (CSV, INAD, Registro Imprese): senza
 * distinzione tra maiuscole e minuscole e senza spazi attorno. Le fonti non sono coerenti
 * (bug reale: CSV con "DIBELLA.VIAGGI@PEC.IT" e Registro Imprese con "dibella.viaggi@pec.it"
 * mandavano in PENDING_REVIEW 7 PEC su 13 identiche). I gestori PEC non distinguono il caso
 * nemmeno nella parte locale. Un indirizzo vuoto non è mai uguale a nulla.
 */
export function samePecAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = a?.trim().toLowerCase();
  const nb = b?.trim().toLowerCase();
  return !!na && na === nb;
}
