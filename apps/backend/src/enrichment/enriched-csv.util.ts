/**
 * CSV arricciato in output dalla dashboard Arricchimento: formato pronto per
 * l'import nel wizard campagne. QUOTE_ALL deliberato (il vecchio convertitore
 * sendcsv usava QUOTE_MINIMAL perché imposto dal portale SEND — requisito del
 * vecchio target, non nostro).
 */
export const ENRICHED_CSV_HEADERS = [
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

export type EnrichedRow = Partial<Record<(typeof ENRICHED_CSV_HEADERS)[number], string>>;

const quote = (v: string | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export function buildEnrichedCsv(rows: EnrichedRow[]): string {
  const lines = [ENRICHED_CSV_HEADERS.map(quote).join(';')];
  for (const row of rows) {
    lines.push(ENRICHED_CSV_HEADERS.map((h) => quote(row[h])).join(';'));
  }
  return lines.join('\n');
}
