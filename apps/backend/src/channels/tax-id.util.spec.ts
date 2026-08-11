import { isPartitaIva } from './tax-id.util';

describe('isPartitaIva', () => {
  it('riconosce 11 cifre numeriche come Partita IVA', () => {
    expect(isPartitaIva('12345678901')).toBe(true);
  });

  it('accetta spazi ai bordi', () => {
    expect(isPartitaIva('  12345678901  ')).toBe(true);
  });

  it('rifiuta un CF persona fisica (16 alfanumerici)', () => {
    expect(isPartitaIva('RRANGL74M28R701V')).toBe(false);
  });

  it('rifiuta stringhe con lunghezza diversa da 11', () => {
    expect(isPartitaIva('1234567890')).toBe(false);
    expect(isPartitaIva('123456789012')).toBe(false);
  });

  it('rifiuta 11 caratteri non tutti numerici', () => {
    expect(isPartitaIva('1234567890A')).toBe(false);
  });

  it('rifiuta stringa vuota', () => {
    expect(isPartitaIva('')).toBe(false);
  });
});
