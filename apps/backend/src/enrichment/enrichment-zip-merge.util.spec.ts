import AdmZip from 'adm-zip';
import { mergeMaggioliCsv } from './enrichment-zip-merge.util.js';

const RUBRICA_ROW = (id: string, pdf: string) =>
  `${id};pec@pec.it;;MARIO;ROSSI;RSSMRA80A01H501U;;ROSSI MARIO;1;13/03/2026;Oggetto;;;${pdf}`;

const PAG_INDICE_HEADER =
  "'nome file;'destinatario;'cod. fisc. dest;'indirizzo;'indirizzo parte 2;'localita;'comune;'stato estero;'Num. provv;'Data emissione";

function pagIndiceRow(pdf: string, cf: string): string {
  return `'${pdf};'VERDI LUIGI;'${cf};'VIA MILANO 5;';'00067 MORLUPO RM;';';'99;'01/02/2026`;
}

function makeRubricaZip(pdfName: string, id = '1'): AdmZip {
  const zip = new AdmZip();
  zip.addFile('rubrica.csv', Buffer.from(RUBRICA_ROW(id, pdfName), 'utf-8'));
  zip.addFile(`allegati/${pdfName}`, Buffer.from('%PDF-fake'));
  return zip;
}

function makePagIndiceZip(header: string, pdfName: string, cf: string): AdmZip {
  const zip = new AdmZip();
  const csv = [header, pagIndiceRow(pdfName, cf)].join('\n');
  zip.addFile('pag_indice.csv', Buffer.from(csv, 'utf-8'));
  zip.addFile(`allegati/${pdfName}`, Buffer.from('%PDF-fake'));
  return zip;
}

describe('mergeMaggioliCsv', () => {
  it('merge di più rubrica.csv: concatena i record, mai un PDF decompresso', () => {
    const zips = [makeRubricaZip('A.pdf'), makeRubricaZip('B.pdf')];
    const result = mergeMaggioliCsv(zips, ['pezzo1.zip', 'pezzo2.zip']);

    expect(result.records).toHaveLength(2);
    expect(result.records.map((r) => r.pdfFilename)).toEqual(['A.pdf', 'B.pdf']);
    expect(result.entryName).toBe('rubrica.csv');
    expect(result.mergedCsvText.split('\n')).toHaveLength(2);
  });

  it('merge di più pag_indice.csv con header identico: header scritto una sola volta', () => {
    const zips = [
      makePagIndiceZip(PAG_INDICE_HEADER, 'A.pdf', 'AAAAAA00A00A000A'),
      makePagIndiceZip(PAG_INDICE_HEADER, 'B.pdf', 'BBBBBB00A00A000B'),
    ];
    const result = mergeMaggioliCsv(zips, ['pezzo1.zip', 'pezzo2.zip']);

    expect(result.records).toHaveLength(2);
    const lines = result.mergedCsvText.split('\n');
    expect(lines).toHaveLength(3); // header + 2 righe dati
    expect(lines[0]).toBe(PAG_INDICE_HEADER);
  });

  it('formati diversi tra i pezzi (rubrica vs pag_indice) → errore bloccante', () => {
    const zips = [makeRubricaZip('A.pdf'), makePagIndiceZip(PAG_INDICE_HEADER, 'B.pdf', 'BBBBBB00A00A000B')];
    expect(() => mergeMaggioliCsv(zips, ['pezzo1.zip', 'pezzo2.zip'])).toThrow(/stesso formato/);
  });

  it('header pag_indice.csv diverso tra i pezzi → errore bloccante', () => {
    const altHeader = PAG_INDICE_HEADER.replace('Num. provv', 'Numero provvedimento');
    const zips = [
      makePagIndiceZip(PAG_INDICE_HEADER, 'A.pdf', 'AAAAAA00A00A000A'),
      makePagIndiceZip(altHeader, 'B.pdf', 'BBBBBB00A00A000B'),
    ];
    expect(() => mergeMaggioliCsv(zips, ['pezzo1.zip', 'pezzo2.zip'])).toThrow(/[Ii]ntestazione/);
  });

  it('PDF omonimo tra pezzi diversi → errore bloccante', () => {
    const zips = [makeRubricaZip('DUPLICATO.pdf'), makeRubricaZip('DUPLICATO.pdf', '2')];
    expect(() => mergeMaggioliCsv(zips, ['pezzo1.zip', 'pezzo2.zip'])).toThrow(/DUPLICATO\.pdf/);
  });

  it('singolo ZIP (caso non-merge): comportamento invariato', () => {
    const zips = [makeRubricaZip('A.pdf')];
    const result = mergeMaggioliCsv(zips, ['solo.zip']);
    expect(result.records).toHaveLength(1);
  });

  it('ZIP senza rubrica.csv/pag_indice.csv tra i pezzi → errore con nome file incriminato', () => {
    const empty = new AdmZip();
    empty.addFile('allegati/x.pdf', Buffer.from('x'));
    const zips = [makeRubricaZip('A.pdf'), empty];
    expect(() => mergeMaggioliCsv(zips, ['pezzo1.zip', 'vuoto.zip'])).toThrow(/vuoto\.zip/);
  });
});
