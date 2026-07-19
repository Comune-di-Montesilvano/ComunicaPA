import * as fs from 'fs';
import {
  assembleChunkedUpload,
  chunkPartPath,
  cleanupChunkedUpload,
  initChunkedUpload,
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
    await expect(assembleChunkedUpload('id-mai-esistito')).rejects.toThrow(/non trovata/);
  });
});
