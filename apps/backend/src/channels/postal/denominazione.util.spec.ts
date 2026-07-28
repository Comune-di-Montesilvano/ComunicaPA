import { splitDenominazione } from './denominazione.util';

describe('splitDenominazione', () => {
  it('nome corto: denominazione1 piena, denominazione2 assente', () => {
    const result = splitDenominazione('Mario Rossi', []);
    expect(result).toEqual({ denominazione1: 'Mario Rossi', truncated: false });
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
    expect(result).toEqual({ denominazione1: 'Mario Rossi', truncated: false });
  });

  it('rispetta un maxPerLine custom', () => {
    const result = splitDenominazione('Mario Rossi Verdi', [], 10);
    expect(result.denominazione1.length).toBeLessThanOrEqual(10);
  });

  it('non applica abbreviazioni se il nome rientra già nel limite (anche se contiene il pattern)', () => {
    const nome = 'EREDI DI ERASMO ALESSANDRO';
    const result = splitDenominazione(nome, [
      { pattern: 'EREDI DI', replacement: 'X' },
    ]);
    expect(result).toEqual({ denominazione1: nome, truncated: false });
  });

  it('abbreviazioni non-array: trattate come tabella vuota, nessun crash', () => {
    const nome = 'IMPERSONALMENTE E COLLETTIVAMENTE AGLI EREDI DI ERASMO ALESSANDRO';
    // @ts-expect-error - simula un valore malformato salvato in app_settings (oggetto invece di array)
    const result = splitDenominazione(nome, { pattern: 'X', replacement: 'Y' });
    expect(result.denominazione1 + (result.denominazione2 ? ' ' + result.denominazione2 : '')).not.toContain('undefined');
  });

  it('ignora una voce con pattern vuoto', () => {
    const nome = 'IMPERSONALMENTE E COLLETTIVAMENTE AGLI EREDI DI ERASMO ALESSANDRO';
    const result = splitDenominazione(nome, [{ pattern: '', replacement: 'X' }]);
    // Il testo non viene spezzato carattere per carattere (bug che si avrebbe con text.split(''))
    expect(result.denominazione1.length).toBeLessThanOrEqual(44);
    expect(`${result.denominazione1}${result.denominazione2 ? ' ' + result.denominazione2 : ''}`).not.toBe('');
    expect(result.denominazione1.startsWith('I')).toBe(true);
  });

  it('ignora una voce con replacement mancante', () => {
    const nome = 'IMPERSONALMENTE E COLLETTIVAMENTE AGLI EREDI DI ERASMO ALESSANDRO';
    const result = splitDenominazione(nome, [
      // @ts-expect-error - simula un valore malformato salvato in app_settings (replacement mancante)
      { pattern: 'IMPERSONALMENTE E COLLETTIVAMENTE AGLI EREDI DI' },
    ]);
    const combined = `${result.denominazione1}${result.denominazione2 ? ' ' + result.denominazione2 : ''}`;
    expect(combined).not.toContain('undefined');
  });

  it('applica solo la voce valida quando una è malformata', () => {
    const nome = 'IMPERSONALMENTE E COLLETTIVAMENTE AGLI EREDI DI ERASMO ALESSANDRO';
    const result = splitDenominazione(nome, [
      { pattern: 'IMPERSONALMENTE E COLLETTIVAMENTE AGLI EREDI DI', replacement: 'EREDI DI' },
      // @ts-expect-error - voce malformata (replacement mancante), va ignorata
      { pattern: 'ALESSANDRO' },
    ]);
    expect(result.denominazione1).toBe('EREDI DI ERASMO ALESSANDRO');
  });
});
