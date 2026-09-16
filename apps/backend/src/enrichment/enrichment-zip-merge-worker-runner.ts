import { Worker } from 'node:worker_threads';

export interface RunZipMergeWorkerInput {
  zipPaths: string[];
  zipFilenames: string[];
  outputPath: string;
}

export interface RunZipMergeWorkerResult {
  totalRecords: number;
}

/**
 * Lancia `enrichment-zip-merge.worker.js` (compilato accanto a questo file in
 * `dist/`) su un thread OS separato e attende l'esito. `import.meta.url`
 * risolve al file compilato reale sotto NodeNext/ESM — stesso pattern degli
 * altri import relativi `.js` di questo backend.
 */
export function runZipMergeWorker(input: RunZipMergeWorkerInput): Promise<RunZipMergeWorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./enrichment-zip-merge.worker.js', import.meta.url), {
      workerData: input,
    });
    worker.once('message', (msg: { ok: boolean; totalRecords?: number; message?: string }) => {
      if (msg.ok) {
        resolve({ totalRecords: msg.totalRecords ?? 0 });
      } else {
        reject(new Error(msg.message ?? 'Errore durante il merge ZIP'));
      }
      void worker.terminate();
    });
    worker.once('error', (err) => reject(err));
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker merge ZIP terminato con codice ${code}`));
    });
  });
}
