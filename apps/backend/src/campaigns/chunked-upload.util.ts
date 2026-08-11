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
    throw new Error(`uploadId non valido: atteso un UUID, ricevuto "${String(uploadId)}"`);
  }
  return join(CHUNK_ROOT, uploadId);
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
 * `destination` deve usare QUESTA funzione (mai `chunkUploadDir()` diretta)
 * e reagire a `null` con `cb(new BadRequestException(...), '')`, mai un
 * throw.
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

/**
 * Best-effort, chiamata quasi sempre da un blocco `finally` a valle di un
 * `try/catch` che ha già gestito l'esito reale (vedi
 * enrichment.controller.ts, io-services.controller.ts, campaigns.controller.ts
 * — pattern identico in tutti e 4). Un `uploadId` malformato/già invalidato
 * qui non deve MAI lanciare: un throw dentro un `finally` sovrascrive
 * silenziosamente il risultato/l'eccezione già prodotti dal blocco `try`
 * (bug reale trovato in verifica di questo stesso fix — un `complete()` che
 * gestiva correttamente un uploadId non valido rispondendo `{blocked:true}`
 * tornava invece una promise rigettata perché il `finally` la sovrascriveva).
 * Nessun dato sensibile a rischio nel no-op: un id di forma invalida non ha
 * comunque mai potuto risolvere a una directory reale sotto CHUNK_ROOT.
 */
export function cleanupChunkedUpload(uploadId: string): void {
  if (!isValidUploadId(uploadId)) return;
  fs.rmSync(chunkUploadDir(uploadId), { recursive: true, force: true });
}
