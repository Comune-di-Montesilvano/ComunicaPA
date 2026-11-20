import { describe, expect, it } from 'vitest';
import { guessOcrColumns, ocrPairs, parseOcrCsv } from '../src/ocr-csv';

describe('parseOcrCsv', () => {
  it('separatore ";" con BOM, CRLF, virgolette e righe vuote', () => {
    const csv = parseOcrCsv(String.fromCharCode(0xfeff) + 'Codice Fiscale;Nominativo;OCR\r\nRSSMRA80A01H501U;"Rossi; Mario";111111111111111111\r\n\r\n');
    expect(csv.headers).toEqual(['Codice Fiscale', 'Nominativo', 'OCR']);
    expect(csv.rows).toEqual([['RSSMRA80A01H501U', 'Rossi; Mario', '111111111111111111']]);
  });

  it('separatore "," e "" come escape', () => {
    const csv = parseOcrCsv('cf,nome,ocr\nX,"ACME ""SRL""",1');
    expect(csv.rows[0]).toEqual(['X', 'ACME "SRL"', '1']);
  });
});

describe('guessOcrColumns', () => {
  it('riconosce colonne tipiche', () => {
    expect(guessOcrColumns(['Nominativo', 'CODICE_FISCALE', 'Codice OCR'])).toEqual({ cf: 1, ocr: 2 });
    expect(guessOcrColumns(['Partita IVA', 'external_id'])).toEqual({ cf: 0, ocr: 1 });
    expect(guessOcrColumns(['a', 'b'])).toEqual({ cf: -1, ocr: -1 });
  });
});

describe('ocrPairs', () => {
  it('solo righe con CF e OCR', () => {
    const csv = parseOcrCsv('cf;ocr\nA;1\n;2\nB;\nC;3');
    expect(ocrPairs(csv, 0, 1)).toEqual([['A', '1'], ['C', '3']]);
  });
});
