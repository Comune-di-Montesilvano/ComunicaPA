import AdmZip from 'adm-zip';
import {
  parseLocalita,
  parseMaggioliZip,
  parsePagIndice,
  parseRubricaPec,
} from './maggioli-parser.js';

// rubrica.csv: ';', senza header, campi posizionali (vedi CLAUDE.md sendcsv):
// 0=raw_id, 1=PEC, 3=nome, 4=cognome, 5=CF, 7=nome completo, 8=n. provv, 9=data, 10=oggetto, 13=nome PDF
const RUBRICA_ROW_PF =
  '36042|ici|P;mario.rossi@pec.it;;MARIO;ROSSI;RSSMRA80A01H501U;;ROSSI MARIO;19009032;13/03/2026;Provvedimento 2020: n. 19009032 emesso il 13/03/2026;;;PROVV_36042_142072.pdf';
const RUBRICA_ROW_PG =
  '36043|ici|P;acme@pec.it;;;;00123456789;;ACME SRL;19009033;13/03/2026;Oggetto PG;;;PROVV_36043_1.pdf';
// Riga corta (meno di 14 campi): va paddata, non crashare
const RUBRICA_ROW_SHORT = 'id;pec@pec.it;;N;C;RSSMRA80A01H501U;;NOME;1;01/01/2026';
// Variante "TARI saldo" a 18 campi (tributo/flag in testa, data spezzata gg/mm/aaaa):
// 0=id, 1=tributo, 2=flag, 3=pec, 4=flag2, 5=nome, 6=cognome, 7=cf, 8=vuoto, 9=nominativo,
// 10=numProvv, 11=giorno, 12=mese, 13=anno, 14=oggetto, 15-16=vuoti, 17=filename
const RUBRICA_ROW_TARI_SALDO =
  '708806;rsu;D;beta@pec.it;0;;;00000000002;;BETA SRLS;708806;25;8;2026;SALDO TARI 2026;;;DOC_708806_161219.pdf';
// Stessa variante "TARI saldo", ma canale email invece di PEC — 16 campi
// invece di 18: la data è già un unico campo dd/mm/aaaa (non spezzata in
// giorno;mese;anno), quindi oggetto/filename scalano di 2 posizioni.
// 0=id, 1=tributo, 2=flag, 3=email, 4=flag2, 5=nome, 6=cognome, 7=cf, 8=vuoto,
// 9=nominativo, 10=numProvv, 11=dataEmissione, 12=oggetto, 13-14=vuoti, 15=filename
const RUBRICA_ROW_TARI_SALDO_MAIL =
  '733460;rsu;D;gamma@example.com;1;GIULIA;GAMMA;GMMGLI80A01H501U;;GAMMA GIULIA;733460;25/08/2026;SALDO TARI 2026;;;DOC_733460_16514.pdf';

const PAG_INDICE = [
  "'nome file;'destinatario;'cod. fisc. dest;'indirizzo;'indirizzo parte 2;'localita;'comune;'stato estero;'Ocr int;'Ocr rid;'Num. provv;'Data emissione;'ocr notifica",
  "'DOC_1.pdf;'VERDI LUIGI;'VRDLGU70A01H501X;'VIA MILANO 5;';'00067 MORLUPO RM;';';'301000000000000001;'RAV123;'99;'01/02/2026;'5890000000049995",
].join('\n');

const PAG_INDICE_SENZA_OCR = [
  "'nome file;'destinatario;'cod. fisc. dest;'indirizzo;'indirizzo parte 2;'localita;'comune;'stato estero;'Num. provv;'Data emissione",
  "'DOC_2.pdf;'BIANCHI ANNA;'BNCNNA80A01H501Y;'VIA ROMA 1;';'00100 ROMA RM;';';'42;'02/02/2026",
].join('\n');

describe('parseLocalita', () => {
  it('località domestica: cap comune provincia', () => {
    expect(parseLocalita('00067 MORLUPO RM')).toEqual({ cap: '00067', comune: 'MORLUPO', provincia: 'RM' });
  });

  it('località senza provincia (estero/malformata)', () => {
    expect(parseLocalita('00000 BERLIN')).toEqual({ cap: '00000', comune: 'BERLIN', provincia: '' });
  });
});

describe('parseRubricaPec', () => {
  it('parsa PF e PG distinguendo dalla lunghezza del CF', () => {
    const records = parseRubricaPec(`${RUBRICA_ROW_PF}\n${RUBRICA_ROW_PG}\n`);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      codiceFiscale: 'RSSMRA80A01H501U',
      tipo: 'PF',
      pec: 'mario.rossi@pec.it',
      nominativo: 'ROSSI MARIO',
      numeroProvvedimento: '19009032',
      dataEmissione: '13/03/2026',
      pdfFilename: 'PROVV_36042_142072.pdf',
      csvAddress: null,
    });
    expect(records[1].tipo).toBe('PG');
  });

  it('righe corte vengono paddate senza errore', () => {
    const records = parseRubricaPec(RUBRICA_ROW_SHORT);
    expect(records).toHaveLength(1);
    expect(records[0].pdfFilename).toBe('');
  });

  it('righe vuote ignorate', () => {
    expect(parseRubricaPec('\n\n')).toHaveLength(0);
  });

  it('ocrNotifica sempre vuota (il formato rubrica PEC non la contiene mai)', () => {
    const records = parseRubricaPec(RUBRICA_ROW_PF);
    expect(records[0].ocrNotifica).toBe('');
  });

  it('variante TARI saldo a 18 campi: filename/pec/cf letti dalla posizione corretta', () => {
    const records = parseRubricaPec(RUBRICA_ROW_TARI_SALDO);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      pec: 'beta@pec.it',
      codiceFiscale: '00000000002',
      tipo: 'PG',
      nominativo: 'BETA SRLS',
      numeroProvvedimento: '708806',
      dataEmissione: '25/8/2026',
      oggetto: 'SALDO TARI 2026',
      pdfFilename: 'DOC_708806_161219.pdf',
    });
  });

  it('variante TARI saldo MAIL a 16 campi (data non spezzata): filename/oggetto letti dalla posizione corretta', () => {
    const records = parseRubricaPec(RUBRICA_ROW_TARI_SALDO_MAIL);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      pec: 'gamma@example.com',
      codiceFiscale: 'GMMGLI80A01H501U',
      tipo: 'PF',
      nominativo: 'GAMMA GIULIA',
      numeroProvvedimento: '733460',
      dataEmissione: '25/08/2026',
      oggetto: 'SALDO TARI 2026',
      pdfFilename: 'DOC_733460_16514.pdf',
    });
  });
});

describe('parsePagIndice', () => {
  it('parsa header con apostrofi e valorizza indirizzo/pagamento da CSV', () => {
    const records = parsePagIndice(PAG_INDICE);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      codiceFiscale: 'VRDLGU70A01H501X',
      nominativo: 'VERDI LUIGI',
      pdfFilename: 'DOC_1.pdf',
      csvNumeroAvviso: '301000000000000001',
      csvNumeroAvvisoAlt: 'RAV123',
    });
    expect(records[0].csvAddress).toEqual({
      indirizzo: 'VIA MILANO 5',
      cap: '00067',
      comune: 'MORLUPO',
      provincia: 'RM',
      statoEstero: '',
    });
  });

  it('legge la colonna "ocr notifica" quando presente', () => {
    const records = parsePagIndice(PAG_INDICE);
    expect(records[0].ocrNotifica).toBe('5890000000049995');
  });

  it('ocrNotifica vuota se la colonna non è presente nel tracciato', () => {
    const records = parsePagIndice(PAG_INDICE_SENZA_OCR);
    expect(records[0].ocrNotifica).toBe('');
    expect(records[0].numeroProvvedimento).toBe('42');
  });
});

describe('parseMaggioliZip', () => {
  it('preferisce pag_indice.csv se presente', () => {
    const zip = new AdmZip();
    zip.addFile('pag_indice.csv', Buffer.from(PAG_INDICE, 'utf-8'));
    zip.addFile('rubrica.csv', Buffer.from(RUBRICA_ROW_PF, 'utf-8'));
    const { records } = parseMaggioliZip(zip);
    expect(records[0].codiceFiscale).toBe('VRDLGU70A01H501X');
  });

  it('usa rubrica.csv altrimenti (anche latin-1)', () => {
    const zip = new AdmZip();
    // 'PERÙ' in latin-1 per verificare il fallback encoding
    const latin1 = Buffer.from(RUBRICA_ROW_PF.replace('ROSSI MARIO', 'ROSSI MARI\xd9'), 'latin1');
    zip.addFile('rubrica.csv', latin1);
    const { records } = parseMaggioliZip(zip);
    expect(records[0].nominativo).toBe('ROSSI MARIÙ');
  });

  it('errore esplicito se nessun indice presente', () => {
    const zip = new AdmZip();
    zip.addFile('allegati/x.pdf', Buffer.from('x'));
    expect(() => parseMaggioliZip(zip)).toThrow(/rubrica\.csv|pag_indice\.csv/);
  });
});
