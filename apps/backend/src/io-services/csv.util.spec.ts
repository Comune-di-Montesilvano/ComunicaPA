import { parseCsvContent, buildCsvContent } from './csv.util';

describe('csv.util', () => {
  describe('parseCsvContent', () => {
    it('usa la prima riga come intestazione quando hasHeaders=true', () => {
      const csv = 'cf,nome\nRSSMRA85M01H501Z,Mario Rossi\nVRDLGI80A01H501W,Luigi Verdi';
      const result = parseCsvContent(csv, true);
      expect(result.headers).toEqual(['cf', 'nome']);
      expect(result.rows).toEqual([
        { cf: 'RSSMRA85M01H501Z', nome: 'Mario Rossi' },
        { cf: 'VRDLGI80A01H501W', nome: 'Luigi Verdi' },
      ]);
    });

    it('genera intestazioni "Colonna N" quando hasHeaders=false', () => {
      const csv = 'RSSMRA85M01H501Z,Mario Rossi';
      const result = parseCsvContent(csv, false);
      expect(result.headers).toEqual(['Colonna 1', 'Colonna 2']);
      expect(result.rows).toEqual([{ 'Colonna 1': 'RSSMRA85M01H501Z', 'Colonna 2': 'Mario Rossi' }]);
    });

    it('gestisce separatore punto e virgola e valori quotati con virgola interna', () => {
      const csv = 'cf;nome\nRSSMRA85M01H501Z;"Rossi, Mario"';
      const result = parseCsvContent(csv, true);
      expect(result.rows).toEqual([{ cf: 'RSSMRA85M01H501Z', nome: 'Rossi, Mario' }]);
    });

    it('ignora righe vuote e ritorna rows vuoto per CSV vuoto', () => {
      expect(parseCsvContent('', true)).toEqual({ headers: [], rows: [] });
      expect(parseCsvContent('cf\n\n\n', true)).toEqual({ headers: ['cf'], rows: [] });
    });

    it('round-trip: de-escapa le virgolette doppie RFC 4180', () => {
      const csv = buildCsvContent(['cf', 'nome'], [{ cf: 'RSSMRA85M01H501Z', nome: 'Rossi "Il Grande"' }]);
      const content = csv.replace(/^﻿/, '');
      const result = parseCsvContent(content, true);
      expect(result.rows[0].nome).toBe('Rossi "Il Grande"');
    });
  });

  describe('buildCsvContent', () => {
    it('quota ogni cella, mantiene ordine colonne ed esclude BOM dal confronto testuale', () => {
      const csv = buildCsvContent(['cf', 'nome'], [{ cf: 'RSSMRA85M01H501Z', nome: 'Rossi "Il Grande"' }]);
      expect(csv.replace(/^﻿/, '')).toBe('"cf","nome"\n"RSSMRA85M01H501Z","Rossi ""Il Grande"""');
    });

    it('antepone BOM UTF-8', () => {
      const csv = buildCsvContent(['cf'], []);
      expect(csv.charCodeAt(0)).toBe(0xFEFF);
    });
  });
});
