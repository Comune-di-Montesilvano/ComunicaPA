import { matchOcrImport, normalizeTaxKey } from './maggioli-ocr-import.util.js';

const OCR_A = '111111111111111111';
const OCR_B = '222222222222222222';

describe('normalizeTaxKey', () => {
  it('maiuscolo senza spazi; P.IVA numerica senza zeri iniziali (Excel) riportata a 11 cifre', () => {
    expect(normalizeTaxKey(' rssmra80a01h501u ')).toBe('RSSMRA80A01H501U');
    expect(normalizeTaxKey('159560366')).toBe('00159560366');
    expect(normalizeTaxKey('12345678903')).toBe('12345678903');
  });
});

describe('matchOcrImport', () => {
  const recipients = [
    { id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', externalId: null },
    { id: 'r2', codiceFiscale: '00159560366', externalId: null },
    { id: 'r3', codiceFiscale: 'VRDLGI80A01H501E', externalId: OCR_A },
    { id: 'r4', codiceFiscale: 'RSSMRA85M01H501Q', externalId: OCR_A },
    { id: 'r5', codiceFiscale: 'RRANGL74M28R701D', externalId: null },
    { id: 'r6', codiceFiscale: 'RRANGL74M28R701D', externalId: null },
    { id: 'r7', codiceFiscale: 'BNCLRA70A41H501X', externalId: null },
  ];

  it('scrive solo dove manca; conta già presenti, diversi, non trovati, ambigui, non validi', () => {
    const { toWrite, summary } = matchOcrImport([
      ['rssmra80a01h501u', OCR_A],          // da scrivere
      ['159560366', OCR_B],                 // P.IVA senza zeri → da scrivere
      ['VRDLGI80A01H501E', OCR_A],          // già presente uguale
      ['RSSMRA85M01H501Q', OCR_B],          // già presente diverso: non toccato
      ['RRANGL74M28R701D', OCR_A],          // due destinatari in campagna: ambiguo
      ['BNCLRA70A41H501X', OCR_A],          // stesso CF con due OCR nel CSV: ambiguo
      ['BNCLRA70A41H501X', OCR_B],
      ['ZZZZZZ00A00Z000Z', OCR_A],          // non in campagna
      ['RSSMRA80A01H501U', '123'],          // OCR troppo corto
      ['', OCR_A],                          // CF vuoto
    ], recipients);

    expect(toWrite).toEqual([{ recipientId: 'r1', ocr: OCR_A }, { recipientId: 'r2', ocr: OCR_B }]);
    expect(summary).toEqual({
      righeCsv: 10, daScrivere: 2, giaPresenti: 1, diversi: 1, nonTrovati: 1,
      ambiguiCampagna: 1, ambiguiCsv: 1, nonValidi: 2, senzaOcrDopo: 3,
    });
  });

  it('stesso CF ripetuto nel CSV con lo stesso OCR: non è ambiguo', () => {
    const { toWrite } = matchOcrImport([['RSSMRA80A01H501U', OCR_A], ['RSSMRA80A01H501U', ` ${OCR_A}`]], recipients);
    expect(toWrite).toHaveLength(1);
  });
});
