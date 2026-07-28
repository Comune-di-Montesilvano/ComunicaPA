import { COUNTRIES, matchCountry } from './countries';

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
});
