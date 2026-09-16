import * as fs from 'fs';
import { basename, join } from 'path';
import { getEnrichmentSourcesDir } from './enrichment-paths.js';

/**
 * Sposta i pezzi ZIP caricati (staging temporaneo del batch upload) nella
 * cartella permanente del job — stesso principio di `addToUploadBatch`
 * (prefisso numerico per preservare l'ordine di arrivo). Nessuna
 * ricompattazione: i file restano ZIP indipendenti, letti al volo da
 * `processEnrich` (vedi commento su `getEnrichmentSourcesDir`).
 * `fs.renameSync` fallisce con EXDEV se le due directory sono su filesystem/
 * volumi diversi — fallback a copy+unlink, comunque solo I/O a livello OS,
 * mai un buffer intero in RAM.
 */
export function moveSourcesIntoJob(jobId: string, zipPaths: string[], zipFilenames: string[]): void {
  const dir = getEnrichmentSourcesDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  zipPaths.forEach((srcPath, i) => {
    const destPath = join(dir, `${String(i).padStart(4, '0')}_${basename(zipFilenames[i])}`);
    try {
      fs.renameSync(srcPath, destPath);
    } catch (err: any) {
      if (err?.code !== 'EXDEV') throw err;
      fs.copyFileSync(srcPath, destPath);
      fs.unlinkSync(srcPath);
    }
  });
}

export function listEnrichmentSources(jobId: string): Array<{ path: string; filename: string }> {
  const dir = getEnrichmentSourcesDir(jobId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .map((entry) => ({
      path: join(dir, entry),
      filename: entry.replace(/^\d+_/, ''),
    }));
}
