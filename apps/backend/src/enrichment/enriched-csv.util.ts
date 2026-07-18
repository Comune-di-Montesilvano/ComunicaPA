/**
 * CSV arricciato in output dalla dashboard Arricchimento: formato pronto per
 * l'import nel wizard campagne. QUOTE_ALL deliberato (il vecchio convertitore
 * sendcsv usava QUOTE_MINIMAL perché imposto dal portale SEND — requisito del
 * vecchio target, non nostro).
 *
 * Header dinamico: le colonne rataN_* (numero_avviso/importo/scadenza per
 * ogni rata) non sono fisse — dipendono dal massimo numero di rate trovate
 * tra tutti i record del job corrente (calcolato dal processor).
 */
export const BASE_CSV_HEADERS = [
  'codice_fiscale',
  'nominativo',
  'tipo',
  'pec',
  'indirizzo',
  'cap',
  'comune',
  'provincia',
  'stato_estero',
  'allegato',
  'numero_avviso',
  'numero_avviso_alternativo',
  'importo',
  'scadenza',
  'numero_provvedimento',
  'data_emissione',
  'oggetto',
] as const;

export function buildEnrichedCsvHeaders(maxRate: number): string[] {
  const headers: string[] = [...BASE_CSV_HEADERS];
  for (let i = 1; i <= maxRate; i++) {
    headers.push(`rata${i}_numero_avviso`, `rata${i}_importo`, `rata${i}_scadenza`);
  }
  return headers;
}

export type EnrichedRow = Partial<Record<string, string>>;

const quote = (v: string | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function buildEnrichedCsv(headers: string[], rows: EnrichedRow[]): string {
  const lines = [headers.map(quote).join(';')];
  for (const row of rows) {
    lines.push(headers.map((h) => quote(row[h])).join(';'));
  }
  return lines.join('\n');
}
