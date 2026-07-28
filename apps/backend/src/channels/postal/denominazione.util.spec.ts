import { splitDenominazione } from './denominazione.util';

describe('splitDenominazione', () => {
  it('nome corto: denominazione1 piena, denominazione2 assente', () => {
    const result = splitDenominazione('Mario Rossi', []);
    expect(result).toEqual({ denominazione1: 'Mario Rossi' });
  });

  it('nome che eccede 44 char va a capo su denominazione2 (word-wrap)', () => {
    const nome = 'Nome Cognome Molto Lungo Che Supera I Quarantaquattro Caratteri';
    const result = splitDenominazione(nome, []);
    expect(result.denominazione1.length).toBeLessThanOrEqual(44);
    expect(result.denominazione2!.length).toBeLessThanOrEqual(44);
    // Nessuna parola spezzata a metà: ricostruendo D1+" "+D2 si riottiene il testo originale
    expect(`${result.denominazione1} ${result.denominazione2}`.trim()).toBe(nome);
  });

  it('applica la tabella di abbreviazioni prima dello split', () => {
    const nome = 'IMPERSONALMENTE E COLLETTIVAMENTE AGLI EREDI DI ERASMO ALESSANDRO';
    const result = splitDenominazione(nome, [
      { pattern: 'IMPERSONALMENTE E COLLETTIVAMENTE AGLI EREDI DI', replacement: 'EREDI DI' },
    ]);
    expect(result.denominazione1).toBe('EREDI DI ERASMO ALESSANDRO');
    expect(result.denominazione1.length).toBeLessThanOrEqual(44);
    expect(result.denominazione2).toBeUndefined();
  });

  it('tronca secco denominazione2 se il risultato eccede 88 char totali anche dopo abbreviazione', () => {
    const nomeLunghissimo = 'A'.repeat(50) + ' ' + 'B'.repeat(50);
    const result = splitDenominazione(nomeLunghissimo, []);
    expect(result.denominazione1.length).toBeLessThanOrEqual(44);
    expect(result.denominazione2!.length).toBeLessThanOrEqual(44);
  });

  it('non applica abbreviazioni che non matchano', () => {
    const result = splitDenominazione('Mario Rossi', [
      { pattern: 'Pattern Inesistente', replacement: 'X' },
    ]);
    expect(result).toEqual({ denominazione1: 'Mario Rossi' });
  });

  it('rispetta un maxPerLine custom', () => {
    const result = splitDenominazione('Mario Rossi Verdi', [], 10);
    expect(result.denominazione1.length).toBeLessThanOrEqual(10);
  });
});
