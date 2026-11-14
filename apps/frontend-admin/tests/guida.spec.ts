import { describe, it, expect } from 'vitest';
import { guidaSlug, guidaSections } from '../src/guida';

describe('guidaSlug', () => {
  it('minuscolo e trattini al posto degli spazi', () => {
    expect(guidaSlug('Problemi frequenti')).toBe('problemi-frequenti');
  });

  it('mantiene le lettere accentate', () => {
    expect(guidaSlug('Così è perché')).toBe('così-è-perché');
  });

  it('toglie la punteggiatura ma tiene trattini e underscore', () => {
    expect(guidaSlug('Date di notifica, termini (art. 26)?')).toBe('date-di-notifica-termini-art-26');
    expect(guidaSlug('Pre-invio_test')).toBe('pre-invio_test');
  });

  it('non collassa gli spazi multipli', () => {
    expect(guidaSlug('A  B')).toBe('a--b');
  });
});

describe('guidaSections', () => {
  it('estrae solo titoli di livello 2 e 3 con id e livello', () => {
    const md = ['# Guida', '## Cos\'è', 'testo', '### Problemi frequenti', '#### Quarto', '##Senza spazio'].join('\n');
    expect(guidaSections(md)).toEqual([
      { id: 'cosè', title: 'Cos\'è', level: 2 },
      { id: 'problemi-frequenti', title: 'Problemi frequenti', level: 3 },
    ]);
  });

  it('ignora i titoli dentro i blocchi di codice', () => {
    const md = ['## Prima', '```', '## Finto', '```', '## Dopo'].join('\n');
    expect(guidaSections(md).map((s) => s.title)).toEqual(['Prima', 'Dopo']);
  });
});
