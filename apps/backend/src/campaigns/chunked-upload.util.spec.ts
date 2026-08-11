import * as fs from 'fs';
import { basename, join } from 'path';
import {
  assembleChunkedUpload,
  chunkPartPath,
  chunkUploadDir,
  cleanupChunkedUpload,
  initChunkedUpload,
  isValidChunkIndex,
  safeChunkUploadDir,
} from './chunked-upload.util';

/**
 * assembleChunkedUpload è condivisa da campagne (CSV destinatari, allegati),
 * arricchimento (ZIP) e io-services (verify-bulk) — bug reale trovato in
 * verifica E2E: `out.end()` non atteso, il chiamante poteva leggere il file
 * assemblato prima del flush completo (ZIP troncato, "Invalid filename" su
 * central directory incompleta). Test dedicato per fissare il contratto
 * "il file su disco al ritorno ha tutti i byte", non delegato solo alla
 * suite completa (che non copre questo file specifico).
 */
describe('assembleChunkedUpload', () => {
  it('il file assemblato ha esattamente la somma dei byte di tutti i chunk (nessun troncamento)', async () => {
    const totalChunks = 20;
    const chunkSize = 100_000; // grande abbastanza da rendere la race concreta senza il fix
    const uploadId = initChunkedUpload('grande.bin', totalChunks);

    let expectedTotal = 0;
    for (let i = 0; i < totalChunks; i++) {
      const chunk = Buffer.alloc(chunkSize, i % 256);
      fs.writeFileSync(chunkPartPath(uploadId, i), chunk);
      expectedTotal += chunk.length;
    }

    const { path, filename } = await assembleChunkedUpload(uploadId);

    expect(filename).toBe('grande.bin');
    const stat = fs.statSync(path);
    expect(stat.size).toBe(expectedTotal);

    // Contenuto genuinamente completo, non solo la dimensione: l'ultimo
    // chunk deve essere leggibile per intero (il punto esatto dove
    // troncava la race pre-fix).
    const assembled = fs.readFileSync(path);
    const lastChunkExpected = Buffer.alloc(chunkSize, (totalChunks - 1) % 256);
    expect(assembled.subarray(assembled.length - chunkSize)).toEqual(lastChunkExpected);

    cleanupChunkedUpload(uploadId);
  });

  it('chunk mancante → errore esplicito, nessun file parziale ritornato come valido', async () => {
    const uploadId = initChunkedUpload('incompleto.bin', 3);
    fs.writeFileSync(chunkPartPath(uploadId, 0), Buffer.from('a'));
    fs.writeFileSync(chunkPartPath(uploadId, 1), Buffer.from('b'));
    // chunk 2 mai scritto

    await expect(assembleChunkedUpload(uploadId)).rejects.toThrow(/Chunk 3\/3 mancante/);

    cleanupChunkedUpload(uploadId);
  });

  it('sessione upload inesistente → errore esplicito', async () => {
    // UUID plausibile (stessa forma di randomUUID()) ma mai generato da
    // initChunkedUpload — deve fallire per "non trovata", non per "non
    // valido" (quella è la validazione di FORMA, verificata a parte sotto).
    await expect(assembleChunkedUpload('11111111-2222-3333-4444-555555555555')).rejects.toThrow(/non trovata/);
  });

  /**
   * Path traversal — secondo finding critico review finale (follow-up):
   * chunk()/complete() su external-attachments.controller.ts passavano
   * `uploadId` non validato fino a chunkUploadDir()/readMeta(). Fix:
   * chunkUploadDir() ora valida la FORMA (UUID v4) come choke point comune
   * a init/chunk/complete — chiude il vettore anche se un punto di chiamata
   * a monte dimenticasse il proprio controllo.
   */
  it('uploadId non a forma di UUID → chunkUploadDir/assembleChunkedUpload rifiutano esplicitamente, mai un path risolto fuori da CHUNK_ROOT', async () => {
    expect(() => chunkUploadDir('../../../../etc')).toThrow(/uploadId non valido/);
    expect(() => chunkPartPath('../../../../etc', 0)).toThrow(/uploadId non valido/);
    await expect(assembleChunkedUpload('../../../../etc')).rejects.toThrow(/uploadId non valido/);
  });

  /**
   * Path traversal — finding critico review finale: un filename tipo
   * "../../../../etc/passwd" (o "../../../../app/dist/main.js") non
   * sanitizzato, propagato invariato fino a fs.copyFileSync(path,
   * join(dir, filename)) in ExternalAttachmentTokensService, risolveva
   * fuori dalla directory di upload/token — scrittura file arbitraria nel
   * container, raggiungibile da chiunque avesse una API key esterna valida.
   * initChunkedUpload() è il choke point condiviso da tutti e 5 i punti di
   * chiamata (campagne CSV/allegati, arricchimento, io-services,
   * external-api): basename() qui chiude il buco ovunque in un colpo solo.
   */
  it('filename con path traversal viene ridotto al solo basename — mai scritto fuori dalla cartella di upload', async () => {
    const uploadId = initChunkedUpload('../../../../etc/passwd', 1);
    const metaPath = join(chunkUploadDir(uploadId), 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

    expect(meta.filename).toBe('passwd');
    expect(meta.filename).toBe(basename('../../../../etc/passwd'));
    expect(meta.filename).not.toContain('..');
    expect(meta.filename).not.toContain('/');

    fs.writeFileSync(chunkPartPath(uploadId, 0), Buffer.from('contenuto innocuo'));
    const { path, filename } = await assembleChunkedUpload(uploadId);

    // Il file assemblato resta DENTRO la cartella di upload, non risolto
    // verso /etc/passwd o qualunque path fuori da chunkUploadDir(uploadId).
    expect(path.startsWith(chunkUploadDir(uploadId))).toBe(true);
    expect(filename).toBe('passwd');

    cleanupChunkedUpload(uploadId);
  });

  it('filename Windows-style con backslash (".. \\ .. \\ evil.pdf") non viene alterato da basename() POSIX, ma resta comunque un nome file letterale sotto Linux (nessun separatore di path reale)', async () => {
    const uploadId = initChunkedUpload('..\\..\\evil.pdf', 1);
    const metaPath = join(chunkUploadDir(uploadId), 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

    // path.basename() è POSIX-only per il separatore '/' nel container Linux
    // di produzione — un backslash non è mai un separatore di directory reale
    // lì, quindi il filename risultante resta un nome file letterale (con
    // backslash dentro), mai un path traversal effettivo su Linux.
    expect(meta.filename).not.toContain('/');

    cleanupChunkedUpload(uploadId);
  });
});

/**
 * Terza occorrenza della stessa classe di bug (review finale, follow-up):
 * i 4 endpoint operatore che condividono questo stesso pattern
 * (campaigns.controller.ts x2, enrichment.controller.ts,
 * io-services.controller.ts, channels/inad/inad-verify.controller.ts)
 * chiamavano `chunkUploadDir()` DIRETTAMENTE dentro un callback
 * `destination` sincrono di multer diskStorage — dopo l'hardening di
 * `chunkUploadDir()` per rifiutare un uploadId non a forma di UUID (fix
 * precedente), quel `throw` sincrono sfuggiva come `uncaughtException`
 * (nessun handler globale in questo repo) e abbatteva l'intero processo
 * Node per una singola richiesta operatore malformata — una regressione di
 * disponibilità introdotta DAL fix stesso, non presente prima.
 * `safeChunkUploadDir()`/`isValidChunkIndex()` sono le funzioni che TUTTI
 * e 5 i controller (i 4 operatore + external-attachments) ora chiamano
 * dentro i propri callback `destination`/`filename` — un test diretto su
 * queste due funzioni copre la logica condivisa dei 3 controller
 * (enrichment/io-services/campaigns) che non hanno un proprio test
 * end-to-end HTTP dedicato (il quarto, inad-verify, ha una prova end-to-end
 * completa in inad-verify-chunk-upload.integration.spec.ts, rappresentativa
 * dell'intero gruppo).
 */
describe('safeChunkUploadDir — mai un throw, per i callback diskStorage sincroni', () => {
  it('uploadId UUID valido → ritorna il path dentro CHUNK_ROOT (nessuna eccezione)', () => {
    const uploadId = initChunkedUpload('elenco.csv', 1);
    const dir = safeChunkUploadDir(uploadId);
    expect(dir).toBe(chunkUploadDir(uploadId));
    cleanupChunkedUpload(uploadId);
  });

  it('uploadId path-traversal → ritorna null, MAI un throw (la differenza cruciale rispetto a chunkUploadDir())', () => {
    expect(() => safeChunkUploadDir('../../../../etc')).not.toThrow();
    expect(safeChunkUploadDir('../../../../etc')).toBeNull();
  });

  it('uploadId assente/non stringa → ritorna null, MAI un throw', () => {
    expect(() => safeChunkUploadDir(undefined)).not.toThrow();
    expect(safeChunkUploadDir(undefined)).toBeNull();
    expect(safeChunkUploadDir(123)).toBeNull();
  });
});

describe('isValidChunkIndex', () => {
  it('accetta solo stringhe di sole cifre', () => {
    expect(isValidChunkIndex('0')).toBe(true);
    expect(isValidChunkIndex('42')).toBe(true);
  });

  it('rifiuta un index con separatori di path (traversal su filename)', () => {
    expect(isValidChunkIndex('../../evil')).toBe(false);
    expect(isValidChunkIndex('0/../../etc')).toBe(false);
    expect(isValidChunkIndex('../../../../etc/passwd')).toBe(false);
  });

  it('rifiuta valori assenti/non stringa/vuoti', () => {
    expect(isValidChunkIndex(undefined)).toBe(false);
    expect(isValidChunkIndex('')).toBe(false);
    expect(isValidChunkIndex(0)).toBe(false);
  });
});
