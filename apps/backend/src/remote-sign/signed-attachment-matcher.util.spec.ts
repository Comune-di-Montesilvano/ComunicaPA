// apps/backend/src/remote-sign/signed-attachment-matcher.util.spec.ts
import { describe, expect, it } from 'vitest';
import { matchSignedFiles } from './signed-attachment-matcher.util.js';

describe('matchSignedFiles', () => {
  const toSign = ['DOC_000001_00001.pdf', 'DOC_000002_00001.pdf'];

  it('abbina il nome identico (case-insensitive) al nome originale', () => {
    const r = matchSignedFiles(['doc_000001_00001.PDF'], toSign, []);
    expect(r.matched).toEqual([{ uploaded: 'doc_000001_00001.PDF', original: 'DOC_000001_00001.pdf' }]);
    expect(r.rejected).toEqual([]);
  });

  it.each(['-signed', '_signed', '.signed', '-firmato', '_firmato', ' (firmato)'])(
    'abbina togliendo il suffisso %s',
    (suffix) => {
      const r = matchSignedFiles([`DOC_000002_00001${suffix}.pdf`], toSign, []);
      expect(r.matched).toEqual([{ uploaded: `DOC_000002_00001${suffix}.pdf`, original: 'DOC_000002_00001.pdf' }]);
    },
  );

  it('rifiuta i .p7m con motivo CAdES', () => {
    const r = matchSignedFiles(['DOC_000001_00001.pdf.p7m'], toSign, []);
    expect(r.matched).toEqual([]);
    expect(r.rejected).toEqual([{ file: 'DOC_000001_00001.pdf.p7m', reason: 'Serve firma PAdES (PDF), non CAdES (.p7m)' }]);
  });

  it('rifiuta i file non PDF', () => {
    const r = matchSignedFiles(['note.txt'], toSign, []);
    expect(r.rejected).toEqual([{ file: 'note.txt', reason: 'Non è un PDF' }]);
  });

  it('rifiuta i file senza abbinamento', () => {
    const r = matchSignedFiles(['ALTRO.pdf'], toSign, []);
    expect(r.rejected).toEqual([{ file: 'ALTRO.pdf', reason: 'Nessun allegato da firmare con questo nome' }]);
  });

  it('rifiuta tutti i file ambigui sullo stesso originale', () => {
    const r = matchSignedFiles(['DOC_000001_00001.pdf', 'DOC_000001_00001-signed.pdf'], toSign, []);
    expect(r.matched).toEqual([]);
    expect(r.rejected).toEqual([
      { file: 'DOC_000001_00001.pdf', reason: 'Più file per lo stesso allegato DOC_000001_00001.pdf' },
      { file: 'DOC_000001_00001-signed.pdf', reason: 'Più file per lo stesso allegato DOC_000001_00001.pdf' },
    ]);
  });

  it('rifiuta i file il cui originale è già firmato validamente', () => {
    const r = matchSignedFiles(['DOC_000009_00001-signed.pdf'], toSign, ['DOC_000009_00001.pdf']);
    expect(r.matched).toEqual([]);
    expect(r.rejected).toEqual([{ file: 'DOC_000009_00001-signed.pdf', reason: 'Allegato già firmato validamente' }]);
  });
});
