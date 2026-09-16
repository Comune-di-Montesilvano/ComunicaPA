import { isPartitaIva, isValidCfOrPiva } from './tax-id.util.js';

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

describe('isValidCfOrPiva', () => {
  it('accetta un CF persona fisica valido (16 alfanumerici)', () => {
    expect(isValidCfOrPiva('RSSMRA80A01H501U')).toBe(true);
  });

  it('accetta CF minuscolo (case-insensitive)', () => {
    expect(isValidCfOrPiva('rssmra80a01h501u')).toBe(true);
  });

  it('accetta una Partita IVA valida (11 cifre)', () => {
    expect(isValidCfOrPiva('12345678901')).toBe(true);
  });

  it('accetta spazi ai bordi', () => {
    expect(isValidCfOrPiva('  12345678901  ')).toBe(true);
  });

  it('rifiuta una PIVA a 10 cifre (zero iniziale perso, non ancora normalizzata)', () => {
    expect(isValidCfOrPiva('2333900682')).toBe(false);
  });

  it('rifiuta un CF a 15 caratteri', () => {
    expect(isValidCfOrPiva('RSSMRA80A01H50')).toBe(false);
  });

  it('rifiuta stringa vuota', () => {
    expect(isValidCfOrPiva('')).toBe(false);
  });
});
