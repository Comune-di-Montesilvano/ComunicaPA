import { normalizeTaxId, recipientKeyOf } from './citizen-claims.js';

describe('normalizeTaxId', () => {
  it('rimuove i prefissi SPID TIN<paese>- e VAT<paese>- e normalizza maiuscole/spazi', () => {
    expect(normalizeTaxId('TINIT-rssmra85m01h501z')).toBe('RSSMRA85M01H501Z');
    expect(normalizeTaxId(' VATIT-01234567890 ')).toBe('01234567890');
    expect(normalizeTaxId('01234567890')).toBe('01234567890');
    expect(normalizeTaxId('PG:IT-01234567890')).toBe('01234567890');
    expect(normalizeTaxId('')).toBe('');
  });
});

describe('recipientKeyOf', () => {
  it('persona fisica: codice fiscale', () => {
    expect(recipientKeyOf({ sub: 's', codiceFiscale: 'RSSMRA85M01H501Z', accessType: 'PF' })).toBe('RSSMRA85M01H501Z');
    expect(recipientKeyOf({ sub: 's', codiceFiscale: 'RSSMRA85M01H501Z' })).toBe('RSSMRA85M01H501Z');
  });

  it('operatore per impresa: P.IVA, mai il codice fiscale della persona', () => {
    expect(recipientKeyOf({ sub: 's', codiceFiscale: 'RSSMRA85M01H501Z', accessType: 'PG', ivaCode: '01234567890' })).toBe('01234567890');
  });

  it('sessione impresa senza P.IVA: nessuna chiave (mai fallback sul CF personale)', () => {
    expect(() => recipientKeyOf({ sub: 's', codiceFiscale: 'RSSMRA85M01H501Z', accessType: 'PG' })).toThrow();
  });
});
