import * as fs from 'fs';
import { basename, join } from 'path';
import { randomUUID } from 'crypto';

/**
 * Assemblaggio lato server di upload spezzati in chunk dal browser: il reverse
 * proxy esterno davanti al backend in produzione ha un limite di dimensione
 * del body che spezzava upload di CSV/ZIP di grandi dimensioni (migliaia di
 * destinatari/allegati) con un errore reso illeggibile dal proxy stesso (vedi
 * commento in campaigns.service.ts uploadCsv/launch). Spezzando l'upload in
 * tante richieste sotto quel limite, il problema si aggira senza dover
 * toccare la configurazione del proxy (fuori da questo repo).
 */

const CHUNK_ROOT = '/tmp/comunicapa-uploads/chunked';

/** Margine di sicurezza (4x) sulla dimensione chunk usata dal client (512KB). */
export const MAX_CHUNK_SIZE_BYTES = 2 * 1024 * 1024;

interface ChunkUploadMeta {
  filename: string;
  totalChunks: number;
}

export function chunkUploadDir(uploadId: string): string {
  return join(CHUNK_ROOT, uploadId);
}

export function chunkPartPath(uploadId: string, index: number): string {
  return join(chunkUploadDir(uploadId), `${index}.part`);
}

export function initChunkedUpload(filename: string, totalChunks: number): string {
  if (!Number.isInteger(totalChunks) || totalChunks < 1) {
    throw new Error('totalChunks deve essere un intero >= 1');
  }
  const uploadId = randomUUID();
  const dir = chunkUploadDir(uploadId);
  fs.mkdirSync(dir, { recursive: true });
  // basename() neutralizza path traversal (stesso idioma già in uso in
  // branding.controller.ts/enrichment.processor.ts): `filename` arriva da
  // input non fidato su TUTTI e 5 i punti di chiamata di questa funzione
  // (upload CSV/allegati campagne, arricchimento, io-services, external-api)
  // e finisce in join(dir, filename) sia qui (assembleChunkedUpload,
  // `assembled-${filename}`) sia a valle in chi consuma il file assemblato
  // (es. ExternalAttachmentTokensService.completeUpload, fs.copyFileSync)
  // — un filename tipo "../../../../app/dist/main.js" senza sanitizzazione
  // risolverebbe fuori dalla directory di upload/token (scrittura file
  // arbitraria nel container).
  const safeFilename = basename(filename);
  const meta: ChunkUploadMeta = { filename: safeFilename, totalChunks };
  fs.writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  return uploadId;
}

function readMeta(uploadId: string): ChunkUploadMeta {
  const metaPath = join(chunkUploadDir(uploadId), 'meta.json');
  if (!fs.existsSync(metaPath)) {
    throw new Error(`Sessione di upload "${uploadId}" non trovata o già completata/scaduta`);
  }
  return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ChunkUploadMeta;
}

/** Concatena i chunk salvati su disco in un unico file, nell'ordine 0..N-1. */
export async function assembleChunkedUpload(uploadId: string): Promise<{ path: string; filename: string }> {
  const meta = readMeta(uploadId);
  const dir = chunkUploadDir(uploadId);

  for (let i = 0; i < meta.totalChunks; i++) {
    if (!fs.existsSync(chunkPartPath(uploadId, i))) {
      throw new Error(`Chunk ${i + 1}/${meta.totalChunks} mancante per l'upload "${uploadId}"`);
    }
  }

  const assembledPath = join(dir, `assembled-${meta.filename}`);
  const out = fs.createWriteStream(assembledPath);
  try {
    for (let i = 0; i < meta.totalChunks; i++) {
      await new Promise<void>((resolve, reject) => {
        const input = fs.createReadStream(chunkPartPath(uploadId, i));
        input.on('error', reject);
        input.on('end', resolve);
        input.pipe(out, { end: false });
      });
    }
  } finally {
    // `out.end()` è asincrono: senza attendere l'evento 'finish' il chiamante
    // può leggere il file assemblato prima che l'ultimo chunk sia stato
    // effettivamente flushato su disco (race — file troncato, ZIP corrotto
    // per adm-zip con "Invalid filename" su central directory incompleta).
    await new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
      out.end();
    });
  }

  return { path: assembledPath, filename: meta.filename };
}

export function cleanupChunkedUpload(uploadId: string): void {
  fs.rmSync(chunkUploadDir(uploadId), { recursive: true, force: true });
}
