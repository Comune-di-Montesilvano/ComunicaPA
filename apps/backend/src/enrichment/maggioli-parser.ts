import type AdmZip from 'adm-zip';

/** Porting TS di reader.py + parse_localita di sendcsv (formato ZIP Maggioli). */

export interface ParsedAddress {
  indirizzo: string;
  cap: string;
  comune: string;
  provincia: string;
  statoEstero: string;
}

export interface MaggioliRecord {
  codiceFiscale: string;
  nominativo: string;
  tipo: 'PF' | 'PG';
  pec: string;
  numeroProvvedimento: string;
  dataEmissione: string;
  oggetto: string;
  pdfFilename: string;
  csvAddress: ParsedAddress | null;
  csvNumeroAvviso: string;
  csvNumeroAvvisoAlt: string;
  ocrNotifica: string;
}

const RE_LOCALITA = /^(\d{5})\s+(.+?)\s+([A-Z]{2})$/;

export function parseLocalita(localita: string): { cap: string; comune: string; provincia: string } {
  const s = localita.trim();
  const m = RE_LOCALITA.exec(s);
  if (m) return { cap: m[1], comune: m[2], provincia: m[3] };
  const parts = s.split(/\s+/);
  return { cap: parts[0] ?? '', comune: parts.slice(1).join(' '), provincia: '' };
}

function tipoFromCf(cf: string): 'PF' | 'PG' {
  return cf.trim().length === 16 ? 'PF' : 'PG';
}

export function parseRubricaPec(text: string): MaggioliRecord[] {
  const records: MaggioliRecord[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(';');
    // Variante "TARI saldo": 18 campi, id;tributo;flag;pec;flag2;nome;cognome;cf;;nominativo;
    // numProvv;giorno;mese;anno;oggetto;;;filename — vs il formato standard a 14 campi sotto.
    if (fields.length >= 18) {
      records.push({
        pec: fields[3].trim(),
        codiceFiscale: fields[7].trim(),
        tipo: tipoFromCf(fields[7]),
        nominativo: fields[9].trim(),
        numeroProvvedimento: fields[10].trim(),
        dataEmissione: [fields[11], fields[12], fields[13]].map((f) => f.trim()).join('/'),
        oggetto: fields[14].trim(),
        pdfFilename: fields[17].trim(),
        csvAddress: null,
        csvNumeroAvviso: '',
        csvNumeroAvvisoAlt: '',
        ocrNotifica: '',
      });
      continue;
    }
    // Stessa variante "TARI saldo", canale email (16 campi): stesso layout di
    // sopra ma con la data già un unico campo dd/mm/aaaa invece di
    // giorno;mese;anno separati — oggetto/filename scalano di 2 posizioni
    // (index 14→12, 17→15). Bug reale: senza questo branch la riga cadeva
    // nel ramo a 14 campi sotto, leggendo pdfFilename da un indice vuoto —
    // "allegato non trovato" per ogni riga del tracciato.
    if (fields.length === 16) {
      records.push({
        pec: fields[3].trim(),
        codiceFiscale: fields[7].trim(),
        tipo: tipoFromCf(fields[7]),
        nominativo: fields[9].trim(),
        numeroProvvedimento: fields[10].trim(),
        dataEmissione: fields[11].trim(),
        oggetto: fields[12].trim(),
        pdfFilename: fields[15].trim(),
        csvAddress: null,
        csvNumeroAvviso: '',
        csvNumeroAvvisoAlt: '',
        ocrNotifica: '',
      });
      continue;
    }
    while (fields.length < 14) fields.push('');
    records.push({
      pec: fields[1].trim(),
      codiceFiscale: fields[5].trim(),
      tipo: tipoFromCf(fields[5]),
      nominativo: fields[7].trim(),
      numeroProvvedimento: fields[8].trim(),
      dataEmissione: fields[9].trim(),
      oggetto: fields[10].trim(),
      pdfFilename: fields[13].trim(),
      csvAddress: null,
      csvNumeroAvviso: '',
      csvNumeroAvvisoAlt: '',
      ocrNotifica: '',
    });
  }
  return records;
}

/** Il formato analogico prefissa OGNI cella con un apostrofo (idempotente da strippare). */
function stripApice(s: string): string {
  return s.replace(/^'+/, '');
}

export function parsePagIndice(text: string): MaggioliRecord[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const header = lines[0].split(';').map((f) => stripApice(f).trim());

  const records: MaggioliRecord[] = [];
  for (const line of lines.slice(1)) {
    const fields = line.split(';').map(stripApice);
    const row: Record<string, string> = {};
    header.forEach((h, idx) => { row[h] = fields[idx] ?? ''; });

    const ind1 = (row['indirizzo'] ?? '').trim();
    const ind2 = (row['indirizzo parte 2'] ?? '').trim();
    const loc = parseLocalita(row['localita'] ?? '');
    const comune = loc.comune || (row['comune'] ?? '').trim();

    records.push({
      pec: '',
      codiceFiscale: (row['cod. fisc. dest'] ?? '').trim(),
      tipo: tipoFromCf(row['cod. fisc. dest'] ?? ''),
      nominativo: (row['destinatario'] ?? '').trim(),
      numeroProvvedimento: (row['Num. provv'] ?? '').trim(),
      dataEmissione: (row['Data emissione'] ?? '').trim(),
      oggetto: '',
      pdfFilename: (row['nome file'] ?? '').trim(),
      csvAddress: {
        indirizzo: ind2 ? `${ind1} ${ind2}`.trim() : ind1,
        cap: loc.cap,
        comune,
        provincia: loc.provincia,
        statoEstero: (row['stato estero'] ?? '').trim(),
      },
      csvNumeroAvviso: (row['Ocr int'] ?? '').trim(),
      csvNumeroAvvisoAlt: (row['Ocr rid'] ?? '').trim(),
      ocrNotifica: (row['ocr notifica'] ?? '').trim(),
    });
  }
  return records;
}

export function decodeCsvBuffer(buf: Buffer): string {
  const utf8 = buf.toString('utf-8');
  // Il replacement char indica byte non validi UTF-8: rubrica Maggioli a volte è latin-1
  return utf8.includes('�') ? buf.toString('latin1') : utf8;
}

export function parseMaggioliZip(zip: AdmZip): { records: MaggioliRecord[] } {
  const pagIndice = zip.getEntry('pag_indice.csv');
  if (pagIndice) {
    return { records: parsePagIndice(decodeCsvBuffer(pagIndice.getData())) };
  }
  const rubrica = zip.getEntry('rubrica.csv');
  if (rubrica) {
    return { records: parseRubricaPec(decodeCsvBuffer(rubrica.getData())) };
  }
  throw new Error('ZIP non riconosciuto: manca rubrica.csv o pag_indice.csv alla radice');
}
