import { COUNTRIES, matchCountry, isValidCap } from './index';

describe('COUNTRIES', () => {
  it('include Italia e una selezione di paesi esteri comuni', () => {
    expect(COUNTRIES).toContain('Italia');
    expect(COUNTRIES).toContain('Svizzera');
    expect(COUNTRIES).toContain('Belgio');
    expect(COUNTRIES).toContain('Germania');
    expect(COUNTRIES).toContain('Canada');
  });

  it('non ha duplicati', () => {
    expect(new Set(COUNTRIES).size).toBe(COUNTRIES.length);
  });
});

describe('matchCountry', () => {
  it('trova un match esatto', () => {
    expect(matchCountry('Svizzera')).toBe('Svizzera');
  });

  it('è case-insensitive', () => {
    expect(matchCountry('svizzera')).toBe('Svizzera');
    expect(matchCountry('SVIZZERA')).toBe('Svizzera');
  });

  it('è accento-insensitive', () => {
    expect(matchCountry('Peru')).toBe('Perù');
    expect(matchCountry('Citta del Vaticano')).toBe('Città del Vaticano');
  });

  it('ignora spazi superflui', () => {
    expect(matchCountry('  Belgio  ')).toBe('Belgio');
  });

  it('ritorna null per stringa vuota', () => {
    expect(matchCountry('')).toBeNull();
    expect(matchCountry('   ')).toBeNull();
  });

  it('ritorna null se nessun match', () => {
    expect(matchCountry('Paese Inesistente XYZ')).toBeNull();
  });

  it("normalizza apostrofo tipografico (curly) a quello dritto", () => {
    expect(matchCountry("Costa d’Avorio")).toBe("Costa d’Avorio");
  });

  it('riconosce "PERU\'" (apostrofo finale al posto della vocale accentata, dato PA comune)', () => {
    expect(matchCountry("PERU'")).toBe('Perù');
  });

  it('riconosce "SUD AFRICA" (due parole) come "Sudafrica" (una parola in COUNTRIES)', () => {
    expect(matchCountry('SUD AFRICA')).toBe('Sudafrica');
  });

  it("riconosce \"CITTA' DEL VATICANO\" (apostrofo + spazi) come \"Città del Vaticano\"", () => {
    expect(matchCountry("CITTA' DEL VATICANO")).toBe('Città del Vaticano');
  });
});

describe('isValidCap', () => {
  it('accetta un CAP di 5 cifre', () => {
    expect(isValidCap('65015')).toBe(true);
  });

  it('rifiuta un valore non numerico o di lunghezza diversa', () => {
    expect(isValidCap('LA')).toBe(false);
    expect(isValidCap('123')).toBe(false);
    expect(isValidCap('123456')).toBe(false);
  });

  it('ignora spazi superflui', () => {
    expect(isValidCap('  65015  ')).toBe(true);
  });
});
