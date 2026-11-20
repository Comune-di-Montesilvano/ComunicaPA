import { checkTaxId, isPartitaIva, isValidCfOrPiva, isValidCodiceFiscale, isValidPartitaIva } from './tax-id.util.js';

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

describe('isValidCodiceFiscale', () => {
  it('accetta un CF con carattere di controllo corretto', () => {
    expect(isValidCodiceFiscale('RSSMRA80A01H501U')).toBe(true);
    expect(isValidCodiceFiscale('rssmra80a01h501u')).toBe(true);
  });

  it('rifiuta un CF con carattere di controllo errato', () => {
    expect(isValidCodiceFiscale('RSSMRA80A01H501A')).toBe(false);
  });

  it('accetta un CF omocodico (cifra sostituita da lettera L-V) con controllo ricalcolato', () => {
    // 1 -> M nell'ultima cifra del codice comune, controllo ricalcolato = M
    expect(isValidCodiceFiscale('RSSMRA80A01H50MM')).toBe(true);
  });

  it('rifiuta una lettera non di omocodia al posto di una cifra', () => {
    expect(isValidCodiceFiscale('RSSMRA80A01H50AU')).toBe(false);
  });

  it('rifiuta un mese inesistente', () => {
    expect(isValidCodiceFiscale('RSSMRA80F01H501U')).toBe(false);
  });
});

describe('isValidPartitaIva', () => {
  it('accetta una PIVA con cifra di controllo corretta', () => {
    expect(isValidPartitaIva('00159560366')).toBe(true);
    expect(isValidPartitaIva('12345678903')).toBe(true);
  });

  it('rifiuta una PIVA con cifra di controllo errata', () => {
    expect(isValidPartitaIva('12345678901')).toBe(false);
  });

  it('rifiuta valori non a 11 cifre', () => {
    expect(isValidPartitaIva('1234567890')).toBe(false);
    expect(isValidPartitaIva('1234567890A')).toBe(false);
  });
});

describe('checkTaxId', () => {
  it('classifica CF e PIVA validi (normalizzati maiuscolo/trim)', () => {
    expect(checkTaxId(' rssmra80a01h501u ')).toEqual({ kind: 'cf', value: 'RSSMRA80A01H501U' });
    expect(checkTaxId('12345678903')).toEqual({ kind: 'piva', value: '12345678903' });
  });

  it('valore vuoto, checksum errati, zeri persi e formato ignoto sono invalid con messaggio dedicato', () => {
    expect(checkTaxId('')).toMatchObject({ kind: 'invalid', error: expect.stringContaining('mancante') });
    expect(checkTaxId('RSSMRA80A01H501A')).toMatchObject({ kind: 'invalid', error: expect.stringContaining('codice fiscale non valido') });
    expect(checkTaxId('12345678901')).toMatchObject({ kind: 'invalid', error: expect.stringContaining('partita IVA non valida') });
    expect(checkTaxId('159560366')).toMatchObject({ kind: 'invalid', error: expect.stringContaining('meno di 11 cifre') });
    expect(checkTaxId('ABC')).toMatchObject({ kind: 'invalid', error: expect.stringContaining('formato non valido') });
  });
});
