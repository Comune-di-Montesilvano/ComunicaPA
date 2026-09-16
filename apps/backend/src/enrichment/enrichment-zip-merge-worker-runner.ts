import { Worker } from 'node:worker_threads';

export interface RunZipMergeWorkerInput {
  zipPaths: string[];
  zipFilenames: string[];
  outputPath: string;
  /** Chiamato appena il worker conosce totalRecords, prima della fase lenta (decompressione/ricompressione PDF). */
  onProgress?: (totalRecords: number) => void;
}

export interface RunZipMergeWorkerResult {
  totalRecords: number;
}

interface WorkerMessage {
  ok: boolean;
  phase?: 'csv-merged' | 'done';
  totalRecords?: number;
  message?: string;
}

/**
 * Lancia `enrichment-zip-merge.worker.js` (compilato accanto a questo file in
 * `dist/`) su un thread OS separato e attende l'esito. `import.meta.url`
 * risolve al file compilato reale sotto NodeNext/ESM — stesso pattern degli
 * altri import relativi `.js` di questo backend. Il worker manda due
 * messaggi a esito positivo (`csv-merged` poi `done`) — solo il secondo
 * risolve la promise, il primo va solo a `onProgress`.
 */
export function runZipMergeWorker(input: RunZipMergeWorkerInput): Promise<RunZipMergeWorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./enrichment-zip-merge.worker.js', import.meta.url), {
      workerData: { zipPaths: input.zipPaths, zipFilenames: input.zipFilenames, outputPath: input.outputPath },
    });
    worker.on('message', (msg: WorkerMessage) => {
      if (!msg.ok) {
        reject(new Error(msg.message ?? 'Errore durante il merge ZIP'));
        void worker.terminate();
        return;
      }
      if (msg.phase === 'csv-merged') {
        input.onProgress?.(msg.totalRecords ?? 0);
        return;
      }
      resolve({ totalRecords: msg.totalRecords ?? 0 });
      void worker.terminate();
    });
    worker.once('error', (err) => reject(err));
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker merge ZIP terminato con codice ${code}`));
    });
  });
}
