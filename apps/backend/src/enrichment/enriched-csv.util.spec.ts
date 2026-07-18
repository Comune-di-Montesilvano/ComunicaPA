import { BASE_CSV_HEADERS, buildEnrichedCsv, buildEnrichedCsvHeaders } from './enriched-csv.util';

describe('buildEnrichedCsvHeaders', () => {
  it('maxRate=0: solo le colonne base', () => {
    expect(buildEnrichedCsvHeaders(0)).toEqual([...BASE_CSV_HEADERS]);
  });

  it('maxRate=2: base + rata1_* + rata2_*', () => {
    const headers = buildEnrichedCsvHeaders(2);
    expect(headers).toEqual([
      ...BASE_CSV_HEADERS,
      'rata1_numero_avviso', 'rata1_importo', 'rata1_scadenza',
      'rata2_numero_avviso', 'rata2_importo', 'rata2_scadenza',
    ]);
  });
});

describe('buildEnrichedCsv', () => {
  it('header presente, celle SEMPRE virgolettate, delimitatore ;', () => {
    const headers = buildEnrichedCsvHeaders(0);
    const csv = buildEnrichedCsv(headers, [
      { codice_fiscale: 'RSSMRA80A01H501U', nominativo: 'ROSSI MARIO', importo: '761,00' },
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(headers.map((h) => `"${h}"`).join(';'));
    expect(lines[1].startsWith('"RSSMRA80A01H501U";"ROSSI MARIO"')).toBe(true);
    expect(lines[1].split(';')).toHaveLength(headers.length);
    expect(lines[1].split(';').every((c) => c.startsWith('"') && c.endsWith('"'))).toBe(true);
  });

  it('righe con meno rate del massimo del job lasciano le colonne rataN eccedenti vuote', () => {
    const headers = buildEnrichedCsvHeaders(2);
    const csv = buildEnrichedCsv(headers, [
      { codice_fiscale: 'A', rata1_importo: '380,50' }, // solo 1 rata: rata2_* vuote
    ]);
    const lines = csv.split('\n');
    const cells = lines[1].split(';');
    const rata1ImportoIdx = headers.indexOf('rata1_importo');
    const rata2ImportoIdx = headers.indexOf('rata2_importo');
    expect(cells[rata1ImportoIdx]).toBe('"380,50"');
    expect(cells[rata2ImportoIdx]).toBe('""');
  });

  it('escape virgolette interne raddoppiandole', () => {
    const headers = buildEnrichedCsvHeaders(0);
    const csv = buildEnrichedCsv(headers, [{ nominativo: 'DITTA "LA VELOCE"' }]);
    expect(csv).toContain('"DITTA ""LA VELOCE"""');
  });

  it('nessun BOM iniziale', () => {
    const headers = buildEnrichedCsvHeaders(0);
    expect(buildEnrichedCsv(headers, []).charCodeAt(0)).not.toBe(0xfeff);
  });
});
