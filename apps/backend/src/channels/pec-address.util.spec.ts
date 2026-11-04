import { samePecAddress } from './pec-address.util.js';

describe('samePecAddress', () => {
  it('stesso indirizzo con maiuscole diverse → uguale (caso reale: PEC su file in maiuscolo, Registro Imprese in minuscolo)', () => {
    expect(samePecAddress('01926010685@IMPRESA.ITALIA.IT', '01926010685@impresa.italia.it')).toBe(true);
    expect(samePecAddress('DIBELLA.VIAGGI@PEC.IT', 'dibella.viaggi@pec.it')).toBe(true);
  });

  it('spazi attorno ignorati', () => {
    expect(samePecAddress('  giama2@pec.it ', 'GIAMA2@PEC.IT')).toBe(true);
  });

  it('indirizzi diversi → diverso', () => {
    expect(samePecAddress('outletnottidorogroupsrl@pec.it', 'outletnottidorogroup@pec.it')).toBe(false);
    expect(samePecAddress('foodworld@pec.it', 'foodworldsrls@legalmail.it')).toBe(false);
  });

  it('null, undefined o vuoto da una parte sola → diverso; vuoti da entrambe → mai uguali (nessun indirizzo da confrontare)', () => {
    expect(samePecAddress(null, 'a@pec.it')).toBe(false);
    expect(samePecAddress('a@pec.it', undefined)).toBe(false);
    expect(samePecAddress('a@pec.it', '   ')).toBe(false);
    expect(samePecAddress(null, null)).toBe(false);
    expect(samePecAddress('', '')).toBe(false);
  });
});
