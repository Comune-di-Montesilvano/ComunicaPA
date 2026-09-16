import AdmZip from 'adm-zip';
import { decodeCsvBuffer, parseMaggioliZip, type MaggioliRecord } from './maggioli-parser.js';

/**
 * Tracciati Maggioli a volte arrivano spezzati in più ZIP per problemi di
 * download (vedi CLAUDE.md). Ogni pezzo ha una propria rubrica.csv/
 * pag_indice.csv + allegati/ (righe/destinatari diversi) — questa funzione
 * li tratta come un unico tracciato: valida che siano compatibili (stesso
 * formato, stesso header per pag_indice.csv, nessun PDF omonimo tra pezzi
 * diversi) e produce un unico ZIP merged, così EnrichmentProcessor continua
 * a leggere un solo source.zip come per un job a singolo file.
 */

export interface MergedZipResult {
  records: MaggioliRecord[];
  zipBuffer: Buffer;
}

export interface MergedCsvResult {
  records: MaggioliRecord[];
  mergedCsvText: string;
  entryName: 'rubrica.csv' | 'pag_indice.csv';
}

/**
 * Fase veloce (solo testo, nessun PDF toccato): valida compatibilità tra i
 * pezzi e concatena i CSV. Separata da `buildMergedZipBuffer` (lenta,
 * CPU-bound) per poter dare feedback (`totalRecords`) all'operatore subito,
 * prima di spacchettare/ricomprimere i PDF — vedi `enrichment.worker.ts`.
 * Lancia un Error col messaggio (in italiano) da mostrare come `blocked`.
 */
export function mergeMaggioliCsv(zips: AdmZip[], filenames: string[]): MergedCsvResult {
  const entryNames = zips.map((zip) => {
    if (zip.getEntry('pag_indice.csv')) return 'pag_indice.csv' as const;
    if (zip.getEntry('rubrica.csv')) return 'rubrica.csv' as const;
    return null;
  });

  const missingIdx = entryNames.findIndex((n) => n === null);
  if (missingIdx !== -1) {
    throw new Error(`ZIP "${filenames[missingIdx]}" non riconosciuto: manca rubrica.csv o pag_indice.csv alla radice`);
  }

  const entryName = entryNames[0] as 'rubrica.csv' | 'pag_indice.csv';
  const mismatchFormatIdx = entryNames.findIndex((n) => n !== entryName);
  if (mismatchFormatIdx !== -1) {
    throw new Error(
      `I file caricati devono avere tutti lo stesso formato tracciato: "${filenames[0]}" usa ${entryName}, ` +
        `"${filenames[mismatchFormatIdx]}" usa ${entryNames[mismatchFormatIdx]}`,
    );
  }

  const csvTexts = zips.map((zip) => decodeCsvBuffer(zip.getEntry(entryName)!.getData()));

  if (entryName === 'pag_indice.csv') {
    const headerLines = csvTexts.map((t) => (t.split(/\r?\n/)[0] ?? '').trim());
    const firstHeader = headerLines[0];
    const mismatchHeaderIdx = headerLines.findIndex((h) => h !== firstHeader);
    if (mismatchHeaderIdx !== -1) {
      throw new Error(
        `Intestazione pag_indice.csv diversa tra i file caricati: "${filenames[0]}" e ` +
          `"${filenames[mismatchHeaderIdx]}" non combaciano`,
      );
    }
  }

  const mergedCsvText =
    entryName === 'pag_indice.csv'
      ? [csvTexts[0].split(/\r?\n/)[0], ...csvTexts.flatMap((t) => t.split(/\r?\n/).slice(1))].join('\n')
      : csvTexts.join('\n');

  const records: MaggioliRecord[] = [];
  // pdfFilename -> filename dello ZIP di origine, per il messaggio d'errore
  const pdfSeenIn = new Map<string, { filename: string; zipIndex: number }>();
  for (let i = 0; i < zips.length; i++) {
    const { records: zipRecords } = parseMaggioliZip(zips[i]);
    for (const rec of zipRecords) {
      if (rec.pdfFilename) {
        const prev = pdfSeenIn.get(rec.pdfFilename);
        if (prev && prev.zipIndex !== i) {
          throw new Error(
            `Allegato "${rec.pdfFilename}" presente sia in "${prev.filename}" sia in "${filenames[i]}": ` +
              `rimuovere il duplicato prima di caricare`,
          );
        }
        if (!prev) pdfSeenIn.set(rec.pdfFilename, { filename: filenames[i], zipIndex: i });
      }
    }
    records.push(...zipRecords);
  }

  return { records, mergedCsvText, entryName };
}

/**
 * Fase lenta (CPU-bound): decompressione di ogni PDF + ricompressione
 * dell'intero ZIP merged. Separata da `mergeMaggioliCsv` apposta — vedi sopra.
 */
export function buildMergedZipBuffer(
  zips: AdmZip[],
  entryName: 'rubrica.csv' | 'pag_indice.csv',
  mergedCsvText: string,
): Buffer {
  const merged = new AdmZip();
  merged.addFile(entryName, Buffer.from(mergedCsvText, 'utf-8'));
  for (const zip of zips) {
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || !entry.entryName.startsWith('allegati/')) continue;
      merged.addFile(entry.entryName, entry.getData());
    }
  }
  return merged.toBuffer();
}

/** Composizione delle due fasi sopra — usata dove il feedback intermedio non serve (es. test). */
export function mergeMaggioliZips(zips: AdmZip[], filenames: string[]): MergedZipResult {
  const { records, mergedCsvText, entryName } = mergeMaggioliCsv(zips, filenames);
  const zipBuffer = buildMergedZipBuffer(zips, entryName, mergedCsvText);
  return { records, zipBuffer };
}
