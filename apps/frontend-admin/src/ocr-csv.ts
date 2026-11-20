/**
 * Lettura del CSV per l'abbinamento a posteriori dell'OCR Maggioli: solo
 * intestazioni e righe, separatore ";" o "," dedotto dalla prima riga,
 * campi tra virgolette con "" come escape. Al backend vanno solo le coppie
 * [CF/P.IVA, OCR] (body JSON piccolo).
 */

export interface OcrCsv {
  headers: string[];
  rows: string[][];
}

function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

export function parseOcrCsv(text: string): OcrCsv {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const first = lines[0];
  const delimiter = (first.match(/;/g)?.length ?? 0) >= (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  return { headers: splitLine(first, delimiter), rows: lines.slice(1).map((l) => splitLine(l, delimiter)) };
}

/** Indici delle colonne CF/P.IVA e OCR più probabili (-1 se nessuna). */
export function guessOcrColumns(headers: string[]): { cf: number; ocr: number } {
  const norm = headers.map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const find = (patterns: RegExp[]) => {
    for (const p of patterns) {
      const i = norm.findIndex((h) => p.test(h));
      if (i >= 0) return i;
    }
    return -1;
  };
  return {
    cf: find([/^codicefiscale/, /^cf$/, /codicefiscale|cfpiva|partitaiva|piva/, /fiscale/]),
    ocr: find([/^ocr/, /ocr/, /quintocampo/, /externalid/, /riferimento/]),
  };
}

/** Coppie [CF/P.IVA, OCR] delle righe con entrambi i valori. */
export function ocrPairs(csv: OcrCsv, cfIndex: number, ocrIndex: number): Array<[string, string]> {
  return csv.rows
    .map((r) => [(r[cfIndex] ?? '').trim(), (r[ocrIndex] ?? '').trim()] as [string, string])
    .filter(([cf, ocr]) => cf && ocr);
}
