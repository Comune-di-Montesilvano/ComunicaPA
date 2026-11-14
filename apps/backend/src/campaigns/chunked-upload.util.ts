import * as fs from 'fs';
import { basename, join, resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { diskStorage, type StorageEngine } from 'multer';

/**
 * Assemblaggio lato server di upload spezzati in chunk dal browser: il reverse
 * proxy esterno davanti al backend in produzione ha un limite di dimensione
 * del body che spezzava upload di CSV/ZIP di grandi dimensioni (migliaia di
 * destinatari/allegati) con un errore reso illeggibile dal proxy stesso (vedi
 * commento in campaigns.service.ts uploadCsv/launch). Spezzando l'upload in
 * tante richieste sotto quel limite, il problema si aggira senza dover
 * toccare la configurazione del proxy (fuori da questo repo).
 */

/** Radice dei chunk (esportata: i test di path traversal la usano per costruire i payload). */
export const CHUNK_ROOT = '/tmp/comunicapa-uploads/chunked';

/** Margine di sicurezza (4x) sulla dimensione chunk usata dal client (512KB). */
export const MAX_CHUNK_SIZE_BYTES = 2 * 1024 * 1024;

/**
 * Età massima di una sessione di upload (mtime della sua cartella, aggiornato
 * a ogni nuovo file di chunk creato — non quando si riscrive un chunk già
 * presente): oltre, `sweepStaleChunkedUploads` la rimuove.
 */
export const CHUNK_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Messaggio unico per sessione inesistente, scaduta o aperta da altri: nessuna distinzione verso il client. */
const SESSION_NOT_FOUND_MESSAGE = 'Sessione di upload non trovata o scaduta';

interface ChunkUploadMeta {
  filename: string;
  totalChunks: number;
  /**
   * Chi ha aperto la sessione (`operatorUploadOwner`/`apiClientUploadOwner`).
   * Assente nelle sessioni create prima dell'introduzione del campo: accettate
   * da chiunque, scadono comunque col sweeper.
   */
  owner?: string;
}

/** Owner di una sessione aperta da un operatore (JWT `sub`), `undefined` senza utente. */
export function operatorUploadOwner(user: { sub?: string } | undefined): string | undefined {
  return user?.sub ? `operator:${user.sub}` : undefined;
}

/** Owner di una sessione aperta da un client della API esterna. */
export function apiClientUploadOwner(clientId: string): string {
  return `api:${clientId}`;
}

// uploadId è SEMPRE generato server-side da initChunkedUpload() (randomUUID()
// qui sotto) — un chiamante legittimo non ha mai motivo di mandarne uno
// diverso. Stesso principio già in uso per ExternalAttachmentRefDto.token
// (create-external-notification.dto.ts): qualunque valore fuori da questa
// forma è per definizione un tentativo di manipolare il path.
const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUploadId(uploadId: unknown): uploadId is string {
  return typeof uploadId === 'string' && UPLOAD_ID_PATTERN.test(uploadId);
}

/**
 * Scelta di sicurezza: `uploadId` arriva da input non fidato su TUTTI i
 * chiamanti di questa funzione, inclusi due percorsi (external-api chunk()/
 * complete()) dove il body arriva o troppo TARDI (dopo che multer ha già
 * scritto su disco nei callback diskStorage) o comunque non passa mai da
 * una validazione a livello DTO. `chunkUploadDir()` è il choke point comune
 * a init/chunk/complete (via readMeta/chunkPartPath) — validare la FORMA qui
 * (UUID v4, mai un path/`..`) chiude il vettore di path traversal
 * indipendentemente da dove viene chiamata, anche se un punto di chiamata a
 * monte dimenticasse il proprio controllo (stesso principio già applicato a
 * `filename`/`basename()` sotto, un secondo livello di difesa non un unico
 * punto di fiducia).
 */
export function chunkUploadDir(uploadId: string): string {
  if (!isValidUploadId(uploadId)) {
    // BadRequestException (sottoclasse di Error): se arriva fino al filtro
    // Nest è un 400, mai un 500.
    throw new BadRequestException('uploadId non valido: atteso un UUID');
  }
  // Seconda barriera esplicita (oltre al pattern UUID): la directory risolta
  // deve stare sotto CHUNK_ROOT.
  const dir = resolve(CHUNK_ROOT, uploadId);
  if (!dir.startsWith(CHUNK_ROOT + sep)) {
    throw new BadRequestException('uploadId non valido: atteso un UUID');
  }
  return dir;
}

export function chunkPartPath(uploadId: string, index: number): string {
  return join(chunkUploadDir(uploadId), `${index}.part`);
}

/**
 * Variante "safe" (mai throw) di chunkUploadDir(), pensata per i callback
 * `destination` di multer diskStorage — SEMPRE sincroni e chiamati DURANTE
 * il parsing multipart, quindi PRIMA di qualunque pipe/exception filter
 * Nest. Un `throw` grezzo lì dentro non viene intercettato né da Express né
 * da Nest: sfugge come `uncaughtException` e — non essendoci in questo repo
 * un handler globale (verificato, `grep -rn uncaughtException src` non
 * trova nulla) — abbatte l'intero processo Node, BullMQ in-flight incluso.
 * Bug reale: la review del fix path-traversal su chunkUploadDir() (che ha
 * introdotto il throw sincrono) ha inizialmente lasciato tutti e 5 i
 * callback `destination` che chiamano questa funzione esposti esattamente a
 * questo — un operatore autenticato con un `uploadId` malformato poteva
 * far crashare l'intero backend con una singola richiesta. Ogni callback
 * `destination` deve usare QUESTA funzione o `chunkedUploadAccess()` (mai
 * `chunkUploadDir()` diretta) e reagire all'errore con
 * `cb(new BadRequestException(...), '')`, mai un throw. Le route operatore
 * usano `operatorChunkUploadOptions()`, che lo fa già.
 */
export function safeChunkUploadDir(uploadId: unknown): string | null {
  if (!isValidUploadId(uploadId)) return null;
  return join(CHUNK_ROOT, uploadId);
}

// Stesso principio di isValidUploadId, applicato all'indice del chunk:
// arriva da input non fidato (route param o body a seconda dell'endpoint) e
// finisce letteralmente in `${index}.part` dentro il callback `filename` di
// multer diskStorage — un valore tipo "../../evil" scriverebbe fuori dalla
// cartella di upload. Solo cifre, nessun separatore di path.
export function isValidChunkIndex(index: unknown): index is string {
  return typeof index === 'string' && /^\d+$/.test(index);
}

export function initChunkedUpload(filename: string, totalChunks: number, owner?: string): string {
  if (!Number.isInteger(totalChunks) || totalChunks < 1) {
    throw new Error('totalChunks deve essere un intero >= 1');
  }
  // Nome base valutato prima di creare la sessione: '', '.' e '..' non sono
  // nomi di file (join(dir, '..') punterebbe alla directory padre).
  const safeFilename = basename(filename);
  if (safeFilename === '' || safeFilename === '.' || safeFilename === '..') {
    throw new BadRequestException('Nome file non valido');
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
  const meta: ChunkUploadMeta = { filename: safeFilename, totalChunks, ...(owner ? { owner } : {}) };
  fs.writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  return uploadId;
}

function readMeta(uploadId: string): ChunkUploadMeta {
  const metaPath = join(chunkUploadDir(uploadId), 'meta.json');
  if (!fs.existsSync(metaPath)) {
    throw new NotFoundException(SESSION_NOT_FOUND_MESSAGE);
  }
  return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as ChunkUploadMeta;
}

/**
 * Esito dell'accesso a una sessione, mai un throw (usabile nei callback
 * sincroni di multer): `invalid` = uploadId non a forma di UUID; `not-found` =
 * sessione inesistente, senza meta.json leggibile o aperta da un altro owner
 * (stessa risposta: non si rivela che la sessione esiste).
 */
export function chunkedUploadAccess(uploadId: unknown, owner: string | undefined): 'ok' | 'invalid' | 'not-found' {
  if (!isValidUploadId(uploadId)) return 'invalid';
  let meta: ChunkUploadMeta;
  try {
    meta = JSON.parse(fs.readFileSync(join(chunkUploadDir(uploadId), 'meta.json'), 'utf8')) as ChunkUploadMeta;
  } catch {
    return 'not-found';
  }
  if (meta.owner !== undefined && meta.owner !== owner) return 'not-found';
  return 'ok';
}

/** Come `chunkedUploadAccess`, ma lancia 400 (forma) o 404 (sessione): da chiamare PRIMA del try/finally di cleanup. */
export function assertChunkedUploadAccess(uploadId: unknown, owner: string | undefined): asserts uploadId is string {
  const access = chunkedUploadAccess(uploadId, owner);
  if (access === 'invalid') throw new BadRequestException('uploadId non valido: atteso un UUID');
  if (access === 'not-found') throw new NotFoundException(SESSION_NOT_FOUND_MESSAGE);
}

/**
 * Opzioni multer comuni alle route operatore `.../upload/chunk/:uploadId/:index`:
 * scrivono solo dentro una sessione esistente aperta dallo stesso operatore
 * (`req.user.sub`, già impostato dal guard JWT quando multer gira). Mai un
 * throw nei callback (vedi `safeChunkUploadDir`): errori passati a `cb`, che
 * Nest rilancia così come sono (400/404).
 */
export function operatorChunkUploadOptions(): { storage: StorageEngine; limits: { fileSize: number } } {
  return {
    storage: diskStorage({
      destination: (req, _file, cb) => {
        const uploadId = req.params['uploadId'];
        const access = chunkedUploadAccess(uploadId, operatorUploadOwner((req as { user?: { sub?: string } }).user));
        if (access === 'invalid') {
          cb(new BadRequestException('uploadId non valido: atteso un UUID'), '');
          return;
        }
        if (access === 'not-found') {
          cb(new NotFoundException(SESSION_NOT_FOUND_MESSAGE), '');
          return;
        }
        cb(null, join(CHUNK_ROOT, uploadId as string));
      },
      filename: (req, _file, cb) => {
        const index = req.params['index'];
        if (!isValidChunkIndex(index)) {
          cb(new BadRequestException('index non valido'), '');
          return;
        }
        cb(null, `${index}.part`);
      },
    }),
    limits: { fileSize: MAX_CHUNK_SIZE_BYTES },
  };
}

/**
 * Rimuove da `root` le sessioni di upload abbandonate (mai completate,
 * rifiutate prima del complete, residui di crash): solo cartelle figlie
 * dirette con nome UUID, mtime più vecchio di `maxAgeMs`. Symlink e file
 * ignorati (`Dirent.isDirectory()` è false per un symlink): non si esce mai
 * da `root`. Ritorna il numero di sessioni rimosse.
 */
export function sweepStaleChunkedUploads(
  root: string = CHUNK_ROOT,
  maxAgeMs: number = CHUNK_SESSION_MAX_AGE_MS,
  now: number = Date.now(),
): number {
  if (!fs.existsSync(root)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidUploadId(entry.name)) continue;
    const dir = join(root, entry.name);
    // Una voce sparita nel frattempo (complete concorrente) o non rimovibile
    // (EBUSY/EACCES) non deve fermare la pulizia delle altre: si salta e la
    // si riprova al giro successivo.
    try {
      const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
      if (!stat?.isDirectory() || now - stat.mtimeMs <= maxAgeMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      continue;
    }
  }
  return removed;
}

/** Concatena i chunk salvati su disco in un unico file, nell'ordine 0..N-1. */
export async function assembleChunkedUpload(uploadId: string): Promise<{ path: string; filename: string }> {
  const meta = readMeta(uploadId);
  const dir = chunkUploadDir(uploadId);

  for (let i = 0; i < meta.totalChunks; i++) {
    if (!fs.existsSync(chunkPartPath(uploadId, i))) {
      throw new BadRequestException(`Chunk ${i + 1}/${meta.totalChunks} mancante: ricaricare il file`);
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

/**
 * Best-effort, chiamata dal blocco `finally` di ogni `complete` chunked
 * (campagne CSV destinatari e allegati, arricchimento, verifica domicili,
 * allegati firmati, external-api — 6 percorsi, stesso schema): uploadId e
 * owner sono già stati verificati da `assertChunkedUploadAccess` PRIMA del
 * `try` (400/404 escono come HTTP, una sessione altrui non arriva mai qui).
 * Non deve comunque MAI lanciare: un throw dentro un `finally` sovrascrive
 * silenziosamente il risultato/l'eccezione già prodotti dal blocco `try`.
 * Un id di forma invalida è un no-op: non può risolvere a una directory
 * sotto CHUNK_ROOT.
 */
export function cleanupChunkedUpload(uploadId: string): void {
  if (!isValidUploadId(uploadId)) return;
  fs.rmSync(chunkUploadDir(uploadId), { recursive: true, force: true });
}
