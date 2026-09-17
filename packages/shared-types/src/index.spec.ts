import { COUNTRIES, matchCountry, isValidCap, abbreviateLongMunicipality } from './index';

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
    expect(matchCountry("Costa d" + String.fromCharCode(0x2019) + "Avorio")).toBe("Costa d" + String.fromCharCode(0x0027) + "Avorio");
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

describe('abbreviateLongMunicipality', () => {
  it('ritorna invariato un nome già entro 30 caratteri', () => {
    expect(abbreviateLongMunicipality('MONTESILVANO')).toBe('MONTESILVANO');
  });

  it('abbrevia i 5 comuni italiani noti oltre 30 caratteri', () => {
    expect(abbreviateLongMunicipality('SAN VALENTINO IN ABRUZZO CITERIORE')).toBe('SAN VALENTINO IN ABRUZZO');
    expect(abbreviateLongMunicipality('PRIMIERO SAN MARTINO DI CASTROZZA')).toBe('PRIMIERO SAN MARTINO CASTROZZA');
    expect(abbreviateLongMunicipality('CASTROCARO TERME E TERRA DEL SOLE')).toBe('CASTROCARO TERME E TERRA SOLE');
    expect(abbreviateLongMunicipality("SANT'ANDREA APOSTOLO DELLO IONIO")).toBe("SANT'ANDREA APOSTOLO IONIO");
    expect(abbreviateLongMunicipality('VILLA SANTA LUCIA DEGLI ABRUZZI')).toBe('VILLA SANTA LUCIA ABRUZZI');
  });

  it('ogni forma abbreviata sta entro 30 caratteri', () => {
    const abbreviated = [
      abbreviateLongMunicipality('SAN VALENTINO IN ABRUZZO CITERIORE'),
      abbreviateLongMunicipality('PRIMIERO SAN MARTINO DI CASTROZZA'),
      abbreviateLongMunicipality('CASTROCARO TERME E TERRA DEL SOLE'),
      abbreviateLongMunicipality("SANT'ANDREA APOSTOLO DELLO IONIO"),
      abbreviateLongMunicipality('VILLA SANTA LUCIA DEGLI ABRUZZI'),
    ];
    for (const name of abbreviated) {
      expect(name.length).toBeLessThanOrEqual(30);
    }
  });

  it('è case/accento/apostrofo-insensitive nel riconoscere il comune', () => {
    expect(abbreviateLongMunicipality('san valentino in abruzzo citeriore')).toBe('SAN VALENTINO IN ABRUZZO');
    expect(abbreviateLongMunicipality('SANT’ANDREA APOSTOLO DELLO IONIO')).toBe("SANT'ANDREA APOSTOLO IONIO");
  });

  it('un nome oltre 30 caratteri ma non mappato torna invariato (nessun troncamento inventato)', () => {
    const longUnknown = 'COMUNE INESISTENTE MOLTO LUNGO DAVVERO';
    expect(abbreviateLongMunicipality(longUnknown)).toBe(longUnknown);
  });
});
