export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

/**
 * Rileva il delimitatore reale contando le occorrenze di `,`/`;` FUORI
 * quote sulla riga header, una sola volta per l'intero file — mai un
 * carattere per carattere che tratta entrambi come intercambiabili (bug
 * reale: un tracciato `;`-delimited non quotato con importi in formato
 * italiano, es. "27,00", vedeva la virgola dell'importo trattata come
 * delimitatore extra, disallineando ogni colonna successiva per quella
 * riga — l'ultima colonna del file usciva fuori dai bound header.length
 * e spariva silenziosamente, senza errore).
 */
function detectDelimiter(headerLine: string): ',' | ';' {
  let inQuotes = false;
  let commas = 0;
  let semicolons = 0;
  for (const char of headerLine) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char === ',') commas++;
    else if (!inQuotes && char === ';') semicolons++;
  }
  return semicolons > commas ? ';' : ',';
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
      if (char === '"') {
        inQuotes = !inQuotes;
      }
    }
  }
  result.push(current.trim());
  return result.map((col) => col.replace(/^"(.*)"$/, '$1').replace(/""/g, '"'));
}

export function parseCsvContent(content: string, hasHeaders: boolean): ParsedCsv {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const delimiter = detectDelimiter(lines[0]);

  let headers: string[];
  let dataLines: string[];
  if (hasHeaders) {
    headers = parseCsvLine(lines[0], delimiter);
    dataLines = lines.slice(1);
  } else {
    const firstLineCols = parseCsvLine(lines[0], delimiter);
    headers = firstLineCols.map((_, idx) => `Colonna ${idx + 1}`);
    dataLines = lines;
  }

  const rows = dataLines.map((line) => {
    const cols = parseCsvLine(line, delimiter);
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx] || '';
    });
    return obj;
  });

  return { headers, rows };
}

export function buildCsvContent(headers: string[], rows: Record<string, string>[]): string {
  const escapeCell = (val: string) => `"${String(val ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.map(escapeCell).join(',')];
  rows.forEach((row) => {
    lines.push(headers.map((h) => escapeCell(row[h] || '')).join(','));
  });
  return '﻿' + lines.join('\n');
}
