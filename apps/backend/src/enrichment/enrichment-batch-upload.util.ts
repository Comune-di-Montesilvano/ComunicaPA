import * as fs from 'fs';
import { basename, join, resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CHUNK_SESSION_MAX_AGE_MS, isValidUploadId, sweepStaleChunkedUploads } from '../campaigns/chunked-upload.util.js';

/**
 * Staging per l'upload di più pezzi ZIP "attigui" di uno stesso tracciato
 * (vedi CLAUDE.md — tracciati Maggioli spezzati per problemi di download).
 * Ogni pezzo passa PRIMA dal chunked-upload esistente (init/chunk/complete,
 * stesso limite ~1MB del proxy esterno) — una volta assemblato viene
 * spostato qui con `addToUploadBatch`, in ordine di arrivo, finché il
 * client non chiama "batch complete" per finalizzare il job. Stesso
 * principio di `chunked-upload.util.ts`: batchId sempre un UUID generato
 * server-side, riusa `isValidUploadId` come unico choke point di validazione.
 *
 * Ciclo di vita di un lotto (`UPLOAD_BATCH_ROOT/<batchId>`):
 * - `initUploadBatch(owner)` crea la cartella con `.batch.json` (owner, stesso
 *   formato delle sessioni chunk: `operator:<sub>`);
 * - `addToUploadBatch` aggiunge i pezzi `NNNN_<nome>`;
 * - `claimUploadBatch` (complete) crea `.completed` una sola volta: da lì il
 *   lotto è "inesistente" per add/complete e appartiene al job di merge, che
 *   sposta i pezzi nella cartella del job e lo rimuove nel suo `finally`
 *   (`EnrichmentProcessor.processMergeBatch`);
 * - complete rifiutato dopo il claim (formato, lotto vuoto, accodamento
 *   fallito): il controller lo rimuove subito;
 * - mai completato: `sweepStaleUploadBatches` (cron orario di
 *   `ChunkedUploadSweeperService`) lo rimuove dopo 24 h di inattività. I lotti
 *   con `.completed` restano per 7 giorni (pezzi referenziati per path
 *   assoluto dal job di merge in coda), poi sono orfani e vengono rimossi.
 */

export const UPLOAD_BATCH_ROOT = '/tmp/comunicapa-uploads/enrichment-batch';

/** Età massima di un lotto mai completato (mtime della cartella, aggiornato a ogni pezzo aggiunto). */
export const UPLOAD_BATCH_MAX_AGE_MS = CHUNK_SESSION_MAX_AGE_MS;

/**
 * Età massima di un lotto completato (mtime di `.completed`): oltre, il suo
 * job di merge non è mai girato (es. sparito da Redis) e lo sweeper lo
 * rimuove. Ampio margine su qualunque attesa in coda.
 */
export const UPLOAD_BATCH_COMPLETED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Voci di servizio del lotto: iniziano con "." e non sono mai pezzi (`NNNN_<nome>`). */
const BATCH_META_FILE = '.batch.json';
/** Marcatore di completamento: una DIRECTORY (mkdir non ricorsivo = atomico, EEXIST al secondo). */
const BATCH_COMPLETED_MARKER = '.completed';

/**
 * Prefisso delle cartelle di staging di `initUploadBatch` (mkdtemp aggiunge
 * 6 caratteri alfanumerici). Mai a forma di UUID: invisibili alle API.
 */
const STAGING_PREFIX = '.staging-';
const STAGING_NAME_PATTERN = /^\.staging-[A-Za-z0-9]{6}$/;

/** Messaggio unico per lotto inesistente, scaduto, già completato o aperto da altri. */
export const UPLOAD_BATCH_NOT_FOUND_MESSAGE = 'Lotto di upload non trovato o scaduto';
const BATCH_INVALID_MESSAGE = 'batchId mancante o non valido: atteso un UUID';

interface UploadBatchMeta {
  /** `operatorUploadOwner(user)`; assente nei lotti creati senza utente. */
  owner?: string;
}

/**
 * Unico punto che traduce un batchId (input non fidato) in una directory:
 * forma UUID e, come seconda barriera esplicita (stesso schema di
 * `chunkUploadDir`), directory risolta sotto `UPLOAD_BATCH_ROOT`.
 */
function batchDir(batchId: unknown): string | null {
  if (!isValidUploadId(batchId)) return null;
  const dir = resolve(UPLOAD_BATCH_ROOT, batchId);
  if (!dir.startsWith(UPLOAD_BATCH_ROOT + sep)) return null;
  return dir;
}

function isPieceEntry(entry: string): boolean {
  return !entry.startsWith('.');
}

/**
 * Marcatore di completamento (`lstat`, niente symlink). Un `.completed` FILE
 * non è mai esistito in produzione (la versione a file non è mai stata
 * rilasciata): non è gestito.
 */
function completedMarker(dir: string): fs.Stats | undefined {
  const stat = fs.lstatSync(join(dir, BATCH_COMPLETED_MARKER), { throwIfNoEntry: false });
  return stat?.isDirectory() ? stat : undefined;
}

function isCompletedDir(dir: string): boolean {
  return completedMarker(dir) !== undefined;
}

/**
 * Il lotto nasce completo in un colpo solo: metadati scritti in una cartella
 * `mkdtemp` sotto la radice, poi `rename` atomico sul nome definitivo. Nessun
 * lotto visibile senza owner, nessuna scrittura su un path prevedibile.
 * Uno staging rimasto da un crash a metà lo rimuove lo sweeper dopo 24 h.
 */
export function initUploadBatch(owner?: string): string {
  const batchId = randomUUID();
  const dir = batchDir(batchId);
  if (!dir) throw new Error('batchId generato non valido');
  fs.mkdirSync(UPLOAD_BATCH_ROOT, { recursive: true });
  const staging = fs.mkdtempSync(join(UPLOAD_BATCH_ROOT, STAGING_PREFIX));
  try {
    const meta: UploadBatchMeta = owner ? { owner } : {};
    fs.writeFileSync(join(staging, BATCH_META_FILE), JSON.stringify(meta));
    fs.renameSync(staging, dir);
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  return batchId;
}

/**
 * Esito dell'accesso a un lotto, mai un throw: `invalid` = batchId non a
 * forma di UUID; `not-found` = lotto inesistente, già completato, con
 * metadati illeggibili o aperto da un altro owner (stessa risposta). I lotti
 * senza `.batch.json` o senza owner (creati prima del campo) sono accettati.
 */
export function uploadBatchAccess(batchId: unknown, owner: string | undefined): 'ok' | 'invalid' | 'not-found' {
  const dir = batchDir(batchId);
  if (!dir) return 'invalid';
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || isCompletedDir(dir)) return 'not-found';
  let meta: UploadBatchMeta;
  try {
    meta = JSON.parse(fs.readFileSync(join(dir, BATCH_META_FILE), 'utf8')) as UploadBatchMeta;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'ok';
    return 'not-found';
  }
  if (meta.owner !== undefined && meta.owner !== owner) return 'not-found';
  return 'ok';
}

/** Come `uploadBatchAccess`, ma lancia 400 (forma) o 404 (lotto). */
export function assertUploadBatchAccess(batchId: unknown, owner: string | undefined): asserts batchId is string {
  const access = uploadBatchAccess(batchId, owner);
  if (access === 'invalid') throw new BadRequestException(BATCH_INVALID_MESSAGE);
  if (access === 'not-found') throw new NotFoundException(UPLOAD_BATCH_NOT_FOUND_MESSAGE);
}

/**
 * Segna il lotto come completato, una sola volta: `mkdir` non ricorsivo della
 * directory `.completed` è atomico, a due complete concorrenti il secondo
 * riceve EEXIST. `false` se già completato o inesistente (ENOENT).
 */
export function claimUploadBatch(batchId: string): boolean {
  const dir = batchDir(batchId);
  if (!dir) return false;
  try {
    fs.mkdirSync(join(dir, BATCH_COMPLETED_MARKER));
    return true;
  } catch {
    return false;
  }
}

/**
 * Sposta il file assemblato nel batch, prefissato con l'indice di arrivo
 * (ordine preservato). Lotto sparito o completato nel frattempo (complete
 * concorrente, sweeper) → 404, stessa risposta di `assertUploadBatchAccess`.
 */
export function addToUploadBatch(batchId: string, assembledPath: string, filename: string): void {
  const dir = batchDir(batchId);
  if (!dir || !fs.existsSync(dir) || isCompletedDir(dir)) {
    throw new NotFoundException(UPLOAD_BATCH_NOT_FOUND_MESSAGE);
  }
  const index = fs.readdirSync(dir).filter(isPieceEntry).length;
  const safeFilename = basename(filename);
  fs.renameSync(assembledPath, join(dir, `${String(index).padStart(4, '0')}_${safeFilename}`));
}

export function listUploadBatchFiles(batchId: string): Array<{ path: string; filename: string }> {
  const dir = batchDir(batchId);
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isPieceEntry)
    .sort()
    .map((entry) => ({
      path: join(dir, entry),
      // rimuove il prefisso "0000_" aggiunto da addToUploadBatch
      filename: entry.replace(/^\d+_/, ''),
    }));
}

/** Best-effort, mai un throw (chiamata anche da blocchi `finally`); id malformato = no-op. */
export function cleanupUploadBatch(batchId: string): void {
  const dir = batchDir(batchId);
  if (!dir) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Rimuove i lotti mai completati più vecchi di `maxAgeMs`, con le stesse
 * garanzie di `sweepStaleChunkedUploads` (solo cartelle figlie con nome UUID,
 * niente symlink, errori per voce ignorati). I lotti completati restano finché
 * `.completed` ha meno di `completedMaxAgeMs` (li rimuove il job di merge
 * quando ha consumato i pezzi); oltre, sono orfani di un job mai eseguito.
 * Stesse regole (nome esatto, directory reale, 24 h) per le cartelle di
 * staging `.staging-XXXXXX` lasciate da un `initUploadBatch` interrotto.
 */
export function sweepStaleUploadBatches(
  root: string = UPLOAD_BATCH_ROOT,
  maxAgeMs: number = UPLOAD_BATCH_MAX_AGE_MS,
  now: number = Date.now(),
  completedMaxAgeMs: number = UPLOAD_BATCH_COMPLETED_MAX_AGE_MS,
): number {
  return sweepStaleChunkedUploads(
    root,
    maxAgeMs,
    now,
    (dir) => {
      const marker = completedMarker(dir);
      return marker !== undefined && now - marker.mtimeMs <= completedMaxAgeMs;
    },
    (name) => isValidUploadId(name) || STAGING_NAME_PATTERN.test(name),
  );
}
