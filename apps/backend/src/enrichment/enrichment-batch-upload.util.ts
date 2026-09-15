import * as fs from 'fs';
import { basename, join } from 'path';
import { randomUUID } from 'crypto';
import { isValidUploadId } from '../campaigns/chunked-upload.util.js';

/**
 * Staging per l'upload di più pezzi ZIP "attigui" di uno stesso tracciato
 * (vedi CLAUDE.md — tracciati Maggioli spezzati per problemi di download).
 * Ogni pezzo passa PRIMA dal chunked-upload esistente (init/chunk/complete,
 * stesso limite ~1MB del proxy esterno) — una volta assemblato viene
 * spostato qui con `addToUploadBatch`, in ordine di arrivo, finché il
 * client non chiama "batch complete" per finalizzare il job. Stesso
 * principio di `chunked-upload.util.ts`: batchId sempre un UUID generato
 * server-side, riusa `isValidUploadId` come unico choke point di validazione.
 */

const BATCH_ROOT = '/tmp/comunicapa-uploads/enrichment-batch';

function batchDir(batchId: string): string | null {
  if (!isValidUploadId(batchId)) return null;
  return join(BATCH_ROOT, batchId);
}

export function initUploadBatch(): string {
  const batchId = randomUUID();
  fs.mkdirSync(join(BATCH_ROOT, batchId), { recursive: true });
  return batchId;
}

/** Sposta il file assemblato nel batch, prefissato con l'indice di arrivo (ordine preservato). */
export function addToUploadBatch(batchId: string, assembledPath: string, filename: string): void {
  const dir = batchDir(batchId);
  if (!dir || !fs.existsSync(dir)) {
    throw new Error(`Batch di upload "${batchId}" non trovato o scaduto`);
  }
  const index = fs.readdirSync(dir).length;
  const safeFilename = basename(filename);
  fs.renameSync(assembledPath, join(dir, `${String(index).padStart(4, '0')}_${safeFilename}`));
}

export function listUploadBatchFiles(batchId: string): Array<{ path: string; filename: string }> {
  const dir = batchDir(batchId);
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .map((entry) => ({
      path: join(dir, entry),
      // rimuove il prefisso "0000_" aggiunto da addToUploadBatch
      filename: entry.replace(/^\d+_/, ''),
    }));
}

export function cleanupUploadBatch(batchId: string): void {
  const dir = batchDir(batchId);
  if (!dir) return;
  fs.rmSync(dir, { recursive: true, force: true });
}
