export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if ((char === ',' || char === ';') && !inQuotes) {
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

  let headers: string[];
  let dataLines: string[];
  if (hasHeaders) {
    headers = parseCsvLine(lines[0]);
    dataLines = lines.slice(1);
  } else {
    const firstLineCols = parseCsvLine(lines[0]);
    headers = firstLineCols.map((_, idx) => `Colonna ${idx + 1}`);
    dataLines = lines;
  }

  const rows = dataLines.map((line) => {
    const cols = parseCsvLine(line);
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
