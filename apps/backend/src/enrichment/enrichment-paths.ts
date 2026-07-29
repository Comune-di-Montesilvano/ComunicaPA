import { join } from 'path';
import { getAttachmentsRoot } from '../attachments/attachment-paths';

export function getEnrichmentDir(jobId: string): string {
  return join(getAttachmentsRoot(), 'enrichment', jobId);
}

export function getEnrichmentSourceZip(jobId: string): string {
  return join(getEnrichmentDir(jobId), 'source.zip');
}

export function getEnrichmentResultCsv(jobId: string): string {
  return join(getEnrichmentDir(jobId), 'result.csv');
}

/**
 * PDF scompattati su disco durante processEnrich (un solo passaggio sullo
 * ZIP sorgente, mentre già si legge entry.getData() per l'estrazione) —
 * evita di riparsare source.zip con AdmZip più volte per gli stessi PDF
 * (download ZIP risultato, creazione bozza campagna): meno lavoro doppio,
 * e il bug "ADM-ZIP: Unknown descriptor format" (limite noto di adm-zip su
 * entry scritte con data descriptor) va gestito una sola volta, nel punto
 * dove già esisteva un warning per-riga.
 */
export function getEnrichmentAttachmentsDir(jobId: string): string {
  return join(getEnrichmentDir(jobId), 'allegati');
}

export function getEnrichmentCheckpoint(jobId: string): string {
  return join(getEnrichmentDir(jobId), 'checkpoint.json');
}
