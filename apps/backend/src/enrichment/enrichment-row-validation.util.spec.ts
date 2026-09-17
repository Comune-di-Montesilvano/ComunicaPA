import { validateRowContentWarnings } from './enrichment-row-validation.util.js';
import type { EnrichedRow } from './enriched-csv.util.js';

function baseRow(overrides: EnrichedRow = {}): EnrichedRow {
  return {
    comune: 'TERAMO',
    provincia: 'TE',
    cap: '64100',
    stato_estero: '',
    codice_fiscale: 'RSSMRA80A01H501U',
    ...overrides,
  };
}

describe('validateRowContentWarnings', () => {
  it('riga completa e valida → nessun warning', () => {
    const warnings = validateRowContentWarnings(baseRow(), 1, 'A.pdf', null);
    expect(warnings).toEqual([]);
  });

  it('città mancante → warning, provincia italiana comunque richiesta', () => {
    const row = baseRow({ comune: '' });
    const warnings = validateRowContentWarnings(row, 1, 'A.pdf', null);
    expect(warnings).toEqual([{ row: 1, pdf: 'A.pdf', message: 'Città mancante' }]);
  });

  it('paese estero riconosciuto → provincia/CAP non richiesti', () => {
    const row = baseRow({ stato_estero: 'Francia', provincia: '', cap: '' });
    const warnings = validateRowContentWarnings(row, 1, 'A.pdf', null);
    expect(warnings).toEqual([]);
  });

  it('paese non riconosciuto → warning dedicato', () => {
    const row = baseRow({ stato_estero: 'Paese Inesistente XYZ' });
    const warnings = validateRowContentWarnings(row, 1, 'A.pdf', null);
    expect(warnings).toContainEqual({ row: 1, pdf: 'A.pdf', message: 'Paese "Paese Inesistente XYZ" non riconosciuto' });
  });

  it('CAP non valido (non 5 cifre) → warning, solo se presente', () => {
    const row = baseRow({ cap: 'ABC' });
    const warnings = validateRowContentWarnings(row, 1, 'A.pdf', null);
    expect(warnings).toContainEqual({ row: 1, pdf: 'A.pdf', message: 'CAP non valido (richieste 5 cifre)' });
  });

  it('CF/PIVA mancante → warning', () => {
    const row = baseRow({ codice_fiscale: '' });
    const warnings = validateRowContentWarnings(row, 1, 'A.pdf', null);
    expect(warnings).toContainEqual({ row: 1, pdf: 'A.pdf', message: 'Codice Fiscale/Partita IVA mancante' });
  });

  it('CF non valido nel CSV ma un CF valido estratto dal PDF → sostituisce e segnala', () => {
    const row = baseRow({ codice_fiscale: 'NONVALIDO' });
    const warnings = validateRowContentWarnings(row, 1, 'A.pdf', 'RSSMRA80A01H501U');
    expect(row.codice_fiscale).toBe('RSSMRA80A01H501U');
    expect(warnings).toContainEqual({
      row: 1, pdf: 'A.pdf',
      message: 'Codice Fiscale/Partita IVA CSV non valido ("NONVALIDO") — sostituito con valore estratto dal PDF',
    });
  });

  it('CF non valido e nessun CF valido dal PDF → solo warning, riga invariata', () => {
    const row = baseRow({ codice_fiscale: 'NONVALIDO' });
    const warnings = validateRowContentWarnings(row, 1, 'A.pdf', null);
    expect(row.codice_fiscale).toBe('NONVALIDO');
    expect(warnings).toContainEqual({ row: 1, pdf: 'A.pdf', message: 'Codice Fiscale/Partita IVA non valido ("NONVALIDO")' });
  });

  it('città troppo lunga, nessun comune noto abbreviabile → tronca e segnala', () => {
    const longRow = baseRow({ comune: 'A'.repeat(31) });
    const warnings = validateRowContentWarnings(longRow, 1, 'A.pdf', null);
    expect(warnings).toContainEqual({ row: 1, pdf: 'A.pdf', message: 'Città troppo lunga (31 caratteri, max 30)' });
    expect(longRow.comune).toHaveLength(30);
  });
});
