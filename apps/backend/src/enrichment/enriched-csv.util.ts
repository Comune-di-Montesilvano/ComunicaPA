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
  'external_id',
] as const;

export function buildEnrichedCsvHeaders(maxRate: number): string[] {
  const headers: string[] = [...BASE_CSV_HEADERS];
  for (let i = 1; i <= maxRate; i++) {
    headers.push(`rata${i}_numero_avviso`, `rata${i}_importo`, `rata${i}_scadenza`);
  }
  return headers;
}

export type EnrichedRow = Partial<Record<string, string>>;

// Newline collassato a spazio, non solo escaped: parseEnrichedCsv (usato da
// regenerateCsv/getRow/saveAddressOverride) fa lo split delle righe su '\n'
// PRIMA di interpretare le virgolette — un valore con un newline embedded
// (es. testo estratto da PDF via pdf-extractor, mai sanificato a monte in
// enrichment.processor.ts) spezzerebbe il round-trip: la riga verrebbe letta
// come due righe distinte, disallineando ogni colonna successiva. Il file
// resta comunque valido CSV/RFC4183 per Excel se aperto direttamente (mai lo
// scriviamo noi con newline embedded), ma qui la garanzia forte è "quello
// che scriviamo lo rileggiamo identico", non la generalità del formato.
const quote = (v: string | undefined) => `"${String(v ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '""')}"`;

export function buildEnrichedCsv(headers: string[], rows: EnrichedRow[]): string {
  const lines = [headers.map(quote).join(';')];
  for (const row of rows) {
    lines.push(headers.map((h) => quote(row[h])).join(';'));
  }
  return lines.join('\n');
}

/**
 * Inverso di buildEnrichedCsv. Sicuro solo sul formato che produciamo noi
 * stessi (QUOTE_ALL, delimitatore ';', nessun newline embedded nei campi —
 * non un parser CSV generico per input esterno/untrusted).
 */
function parseCsvLine(line: string): string[] {
  const matches = line.match(/"(?:[^"]|"")*"/g) ?? [];
  return matches.map((m) => m.slice(1, -1).replace(/""/g, '"'));
}

export function parseEnrichedCsv(content: string): { headers: string[]; rows: EnrichedRow[] } {
  const lines = content.split('\n').filter((l) => l.length > 0);
  const headers = parseCsvLine(lines[0] ?? '');
  const rows: EnrichedRow[] = lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row: EnrichedRow = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
  return { headers, rows };
}
