import { describe, expect, it } from 'vitest';
import { classifyArssError } from './arss-errors.js';

describe('classifyArssError', () => {
  it('0030 → dominio', () => {
    const e = classifyArssError('open', '0030', 'Domain Not Allowed');
    expect(e.kind).toBe('domain');
    expect(e.message).toBe('Dominio non abilitato: verifica Impostazioni → Firma remota');
  });
  it('descrizione con session → sessione', () => {
    expect(classifyArssError('sign', '0001', 'Invalid session id').kind).toBe('session');
  });
  it('in apertura, errori di autenticazione → credenziali', () => {
    const e = classifyArssError('open', '0001', 'OTP not valid');
    expect(e.kind).toBe('credentials');
    expect(e.message).toBe('Credenziali o OTP non validi');
  });
  it('in firma, errore generico → file', () => {
    const e = classifyArssError('sign', '0001', 'Errore generico');
    expect(e.kind).toBe('file');
    expect(e.message).toBe('Aruba ha rifiutato il file (codice 0001: Errore generico)');
  });
  it('in apertura, errore sconosciuto → credenziali col codice', () => {
    expect(classifyArssError('open', null, null).message).toBe('Credenziali o OTP non validi');
  });
});
