import { ENRICHED_CSV_HEADERS, buildEnrichedCsv } from './enriched-csv.util';

describe('buildEnrichedCsv', () => {
  it('header presente, celle SEMPRE virgolettate, delimitatore ;', () => {
    const csv = buildEnrichedCsv([
      { codice_fiscale: 'RSSMRA80A01H501U', nominativo: 'ROSSI MARIO', importo: '761,00' } as any,
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe(ENRICHED_CSV_HEADERS.map((h) => `"${h}"`).join(';'));
    expect(lines[1].startsWith('"RSSMRA80A01H501U";"ROSSI MARIO"')).toBe(true);
    // Ogni cella virgolettata, anche le vuote
    expect(lines[1].split(';')).toHaveLength(ENRICHED_CSV_HEADERS.length);
    expect(lines[1].split(';').every((c) => c.startsWith('"') && c.endsWith('"'))).toBe(true);
  });

  it('escape virgolette interne raddoppiandole', () => {
    const csv = buildEnrichedCsv([{ nominativo: 'DITTA "LA VELOCE"' } as any]);
    expect(csv).toContain('"DITTA ""LA VELOCE"""');
  });

  it('nessun BOM iniziale', () => {
    expect(buildEnrichedCsv([]).charCodeAt(0)).not.toBe(0xfeff);
  });
});
