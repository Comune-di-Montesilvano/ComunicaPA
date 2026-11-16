import { describe, it, expect } from 'vitest';
import { errorMessage } from './error-message.js';

describe('errorMessage', () => {
  it('Error → message', () => {
    expect(errorMessage(new TypeError('boom'))).toBe('boom');
  });

  it('oggetto con message stringa → message', () => {
    expect(errorMessage({ message: 'ldap down', code: 49 })).toBe('ldap down');
  });

  it('senza messaggio → String()', () => {
    expect(errorMessage('testo')).toBe('testo');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage({ message: 7 })).toBe('[object Object]');
  });

  it('senza messaggio e con fallback → fallback', () => {
    expect(errorMessage(undefined, 'Errore sconosciuto')).toBe('Errore sconosciuto');
    expect(errorMessage(new Error(''), 'Errore sconosciuto')).toBe('Errore sconosciuto');
    expect(errorMessage({ code: 1 }, 'Errore sconosciuto')).toBe('Errore sconosciuto');
    expect(errorMessage(new Error('boom'), 'Errore sconosciuto')).toBe('boom');
  });
});
