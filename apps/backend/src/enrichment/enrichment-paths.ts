import { join } from 'path';
import { getAttachmentsRoot } from '../attachments/attachment-paths.js';

export function getEnrichmentDir(jobId: string): string {
  return join(getAttachmentsRoot(), 'enrichment', jobId);
}

/**
 * Pezzi ZIP originali del tracciato (1 o più, "attigui" per tracciati
 * spezzati — vedi CLAUDE.md), spostati qui da `processMergeBatch` invece di
 * essere ricompattati in un unico ZIP merged: ricostruire un secondo ZIP
 * decomprimendo+ricomprimendo ogni PDF (adm-zip, tutto in RAM) per poi
 * ririleggerlo subito dopo in `processEnrich` raddoppiava il lavoro e — su
 * batch multi-GB — teneva simultaneamente in memoria TUTTI i PDF decompressi
 * più il nuovo ZIP compresso, causando OOM/freeze dell'intero host (bug
 * reale). `processEnrich` ora apre questi pezzi direttamente e decomprime un
 * PDF alla volta, esattamente come già faceva per il caso a singolo file.
 */
export function getEnrichmentSourcesDir(jobId: string): string {
  return join(getEnrichmentDir(jobId), 'sources');
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
