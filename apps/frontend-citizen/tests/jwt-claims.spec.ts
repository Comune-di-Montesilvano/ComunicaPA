import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwtClaims } from '../src/lib/jwt-claims';

function jwt(payload: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `x.${b64}.y`;
}

describe('decodeJwtClaims', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('proxy OIDC: fiscal_number TINIT-<CF> e given/family name', () => {
    const r = decodeJwtClaims(jwt({ fiscal_number: 'TINIT-RSSMRA80A01H501U', given_name: 'MARIO', family_name: 'ROSSI' }));
    expect(r).toEqual({ cf: 'RSSMRA80A01H501U', name: 'MARIO ROSSI', provider: 'Identità Digitale' });
  });
  it('claim URI eIDAS e CF in minuscolo', () => {
    const r = decodeJwtClaims(jwt({ 'https://attributes.eid.gov.it/fiscal_number': 'tinit-rssmra80a01h501u' }));
    expect(r.cf).toBe('RSSMRA80A01H501U');
  });
  it('ordine di precedenza: fiscal_number batte codice_fiscale', () => {
    expect(decodeJwtClaims(jwt({ codice_fiscale: 'BBB', fiscal_number: 'AAA' })).cf).toBe('AAA');
  });
  it('senza given/family usa name', () => {
    expect(decodeJwtClaims(jwt({ name: 'Mario Rossi' })).name).toBe('Mario Rossi');
  });
  it('solo given_name: nome parziale', () => {
    expect(decodeJwtClaims(jwt({ given_name: 'Mario' })).name).toBe('Mario');
  });
  it('UTF-8 nel payload', () => {
    expect(decodeJwtClaims(jwt({ given_name: 'Niccolò', family_name: 'Àngelo' })).name).toBe('Niccolò Àngelo');
  });
  it('provider_name ha priorità su amr', () => {
    expect(decodeJwtClaims(jwt({ provider_name: 'Poste ID', amr: ['spid'] })).provider).toBe('Poste ID');
  });
  it.each([
    ['https://identity.interno.gov.it', 'CIE'],
    ['cie', 'CIE'],
    ['SpidL2', 'SPID'],
    ['eidas', 'eIDAS'],
    ['itwallet', 'IT-Wallet'],
    ['pwd', 'PWD'],
  ])('amr %s -> %s', (amr, expected) => {
    expect(decodeJwtClaims(jwt({ amr })).provider).toBe(expected);
    expect(decodeJwtClaims(jwt({ amr: [amr] })).provider).toBe(expected);
  });
  it('token malformato: valori vuoti', () => {
    expect(decodeJwtClaims('abc')).toEqual({ cf: '', name: '' });
  });
  it('payload non decodificabile: fallback con provider di default', () => {
    expect(decodeJwtClaims('a.!!!.c')).toEqual({ cf: '', name: '', provider: 'Identità Digitale' });
  });
});
