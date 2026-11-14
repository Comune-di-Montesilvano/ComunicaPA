import { describe, expect, it } from 'vitest';
import { findPhysicalAddress, getSendStatusMeta, getTextSnippet, statusBadge } from '../src/lib/notification';

describe('getTextSnippet', () => {
  it('vuoto', () => {
    expect(getTextSnippet('')).toBe('');
  });
  it('toglie tag HTML, markdown e liste, normalizza spazi', () => {
    expect(getTextSnippet('<p>Ciao   **Mario**</p>\n- voce [link](https://example.org) *x*')).toBe('Ciao Mario voce link x');
  });
  it('tronca oltre 85 caratteri a 82 + ...', () => {
    const out = getTextSnippet('a'.repeat(100));
    expect(out).toBe('a'.repeat(82) + '...');
    expect(out).toHaveLength(85);
  });
  it('esattamente 85 caratteri non tronca', () => {
    expect(getTextSnippet('a'.repeat(85))).toBe('a'.repeat(85));
  });
});

describe('findPhysicalAddress', () => {
  it('undefined o senza indirizzo -> null', () => {
    expect(findPhysicalAddress(undefined)).toBeNull();
    expect(findPhysicalAddress({ citta: 'Roma' })).toBeNull();
    expect(findPhysicalAddress({ indirizzo: '' })).toBeNull();
  });
  it('indirizzo completo', () => {
    expect(
      findPhysicalAddress({ Indirizzo: 'Via Roma', civico: 10, CAP: '00100', Comune: 'Roma', provincia: 'rm' }),
    ).toBe('Via Roma, 10 - 00100 Roma (RM)');
  });
  it('solo indirizzo', () => {
    expect(findPhysicalAddress({ via: 'Via Verdi' })).toBe('Via Verdi');
  });
  it('solo città', () => {
    expect(findPhysicalAddress({ address: 'Via Verdi 1', localita: 'Milano' })).toBe('Via Verdi 1 - Milano');
  });
});

describe('statusBadge', () => {
  it.each([
    ['sent', 'status-notif-received', 'Ricevuta'],
    ['failed', 'status-notif-failed', 'Non recapitata'],
    ['skipped', 'status-notif-failed', 'Non recapitata'],
    ['pending', 'status-notif-pending', 'In corso'],
    ['queued', 'status-notif-pending', 'In corso'],
  ] as const)('%s', (s, cls, label) => {
    expect(statusBadge(s)).toEqual({ cls, label });
  });
});

describe('getSendStatusMeta', () => {
  it.each([
    ['VALIDATING', 'In validazione', 'status-validating'],
    ['ACCEPTED', 'Depositata', 'status-accepted'],
    ['DELIVERING', 'Invio in corso', 'status-delivering'],
    ['DELIVERED', 'Consegnata', 'status-delivered'],
    ['VIEWED', 'Avvenuto accesso', 'status-viewed'],
    ['EFFECTIVE_DATE', 'Perfezionata per decorrenza termini', 'status-effective-date'],
    ['UNREACHABLE', 'Irreperibile', 'status-unreachable'],
    ['CANCELLED', 'Annullata', 'status-cancelled'],
    ['RETURNED_TO_SENDER', 'Restituita al mittente', 'status-returned-to-sender'],
    ['REFUSED', 'Rifiutata', 'status-refused'],
  ])('%s', (s, label, cls) => {
    const m = getSendStatusMeta(s);
    expect(m.label).toBe(label);
    expect(m.cls).toBe(cls);
    expect(m.desc.length).toBeGreaterThan(0);
  });
  it('stato sconosciuto: etichetta = stato', () => {
    expect(getSendStatusMeta('FOO')).toEqual({ label: 'FOO', cls: 'status-unknown', desc: 'Stato non codificato.' });
  });
});
