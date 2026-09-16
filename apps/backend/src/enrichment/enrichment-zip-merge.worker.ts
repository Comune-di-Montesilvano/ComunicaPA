import { parentPort, workerData } from 'node:worker_threads';
import * as fs from 'fs';
import { dirname } from 'path';
import AdmZip from 'adm-zip';
import { readLargeFileSync } from './large-file-read.util.js';
import { writeLargeFileSync } from './large-file-write.util.js';
import { mergeMaggioliCsv, buildMergedZipBuffer } from './enrichment-zip-merge.util.js';

/**
 * Entry point eseguito su worker_thread separato (vedi `enrichment-zip-merge-worker-runner.ts`).
 * `mergeMaggioliZips` (unzip + re-zip, CPU-bound) e la scrittura del risultato
 * sono operazioni sincrone senza punti di yield possibili (adm-zip non
 * espone un'API a chunk) — l'unico modo per non bloccare l'event loop del
 * processo backend principale durante un merge multi-GB è farle girare su un
 * thread OS separato. Il thread principale (dove gira anche l'HTTP server)
 * resta libero per tutta la durata.
 */
interface MergeWorkerInput {
  zipPaths: string[];
  zipFilenames: string[];
  outputPath: string;
}

const { zipPaths, zipFilenames, outputPath } = workerData as MergeWorkerInput;

try {
  const zips = zipPaths.map((p) => new AdmZip(readLargeFileSync(p)));
  // Fase 1 (veloce, solo testo): appena si conosce totalRecords lo si manda
  // subito al thread principale — l'operatore vede il conteggio corretto
  // senza aspettare la fase 2 (decompressione/ricompressione PDF, molto più
  // lenta su batch multi-GB). Vedi enrichment.processor.ts `processMergeBatch`.
  const { records, mergedCsvText, entryName } = mergeMaggioliCsv(zips, zipFilenames);
  parentPort?.postMessage({ ok: true, phase: 'csv-merged', totalRecords: records.length });

  // Fase 2 (lenta, CPU-bound): qui non c'è modo di cedere ulteriormente —
  // adm-zip non espone un'API a chunk per decompressione/ricompressione.
  const zipBuffer = buildMergedZipBuffer(zips, entryName, mergedCsvText);
  fs.mkdirSync(dirname(outputPath), { recursive: true });
  writeLargeFileSync(outputPath, zipBuffer);
  parentPort?.postMessage({ ok: true, phase: 'done', totalRecords: records.length });
} catch (err: any) {
  parentPort?.postMessage({ ok: false, message: err?.message ?? 'Errore durante il merge ZIP' });
}
