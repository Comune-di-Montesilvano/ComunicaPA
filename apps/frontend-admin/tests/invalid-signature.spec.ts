import { describe, it, expect } from 'vitest';
import { invalidFileLabel, invalidFilesPlainText, invalidRecipientsText } from '../src/components/signature/invalidSignature';

describe('invalidRecipientsText', () => {
  it('conta destinatari, non allegati', () => {
    expect(invalidRecipientsText(1, 1)).toBe('1 destinatario su 1 ha almeno un allegato non firmato validamente');
    expect(invalidRecipientsText(3, 10)).toBe('3 destinatari su 10 hanno almeno un allegato non firmato validamente');
  });
});

describe('invalidFileLabel', () => {
  it('invio singolo: niente conteggio destinatari', () => {
    expect(invalidFileLabel({ filename: 'stipula.pdf', reason: 'File non firmato', recipients: 1 }, 1)).toBe('stipula.pdf: File non firmato');
  });

  it('massivo: quanti destinatari hanno quel file', () => {
    expect(invalidFileLabel({ filename: 'stipula.pdf', reason: 'File non firmato', recipients: 1 }, 5)).toBe('stipula.pdf: File non firmato (1 destinatario)');
    expect(invalidFileLabel({ filename: 'stipula.pdf', reason: 'File non firmato', recipients: 4 }, 5)).toBe('stipula.pdf: File non firmato (4 destinatari)');
  });

  it('senza nome file (verifica precedente o allegato non configurato)', () => {
    expect(invalidFileLabel({ filename: null, reason: 'Allegato non configurato', recipients: 1 }, 1)).toBe('Allegato: Allegato non configurato');
  });
});

describe('invalidFilesPlainText', () => {
  const files = [
    { filename: 'a.pdf', reason: 'File non firmato', recipients: 2 },
    { filename: 'b.pdf', reason: 'CA non riconosciuta', recipients: 1 },
  ];

  it('vuoto senza file', () => {
    expect(invalidFilesPlainText(undefined, undefined, 1)).toBe('');
    expect(invalidFilesPlainText([], 0, 1)).toBe('');
  });

  it('una riga per file, più le voci oltre il limite', () => {
    expect(invalidFilesPlainText(files, 2, 3)).toBe('- a.pdf: File non firmato (2 destinatari)\n- b.pdf: CA non riconosciuta (1 destinatario)');
    expect(invalidFilesPlainText(files, 5, 3)).toMatch(/\n- … e altri 3$/);
  });
});
