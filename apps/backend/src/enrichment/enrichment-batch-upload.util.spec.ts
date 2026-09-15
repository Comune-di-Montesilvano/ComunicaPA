import * as fs from 'fs';
import {
  addToUploadBatch,
  cleanupUploadBatch,
  initUploadBatch,
  listUploadBatchFiles,
} from './enrichment-batch-upload.util.js';

describe('enrichment-batch-upload.util', () => {
  it('init crea un batchId valido, add accoda i file in ordine, list li ritorna ordinati', () => {
    const batchId = initUploadBatch();
    expect(batchId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const src1 = `/tmp/src1-${batchId}.zip`;
    const src2 = `/tmp/src2-${batchId}.zip`;
    fs.writeFileSync(src1, 'contenuto1');
    fs.writeFileSync(src2, 'contenuto2');

    addToUploadBatch(batchId, src1, 'pezzo1.zip');
    addToUploadBatch(batchId, src2, 'pezzo2.zip');

    const files = listUploadBatchFiles(batchId);
    expect(files.map((f) => f.filename)).toEqual(['pezzo1.zip', 'pezzo2.zip']);
    expect(fs.readFileSync(files[0].path, 'utf-8')).toBe('contenuto1');
    expect(fs.readFileSync(files[1].path, 'utf-8')).toBe('contenuto2');

    cleanupUploadBatch(batchId);
    expect(listUploadBatchFiles(batchId)).toHaveLength(0);

    fs.rmSync(src1, { force: true });
    fs.rmSync(src2, { force: true });
  });

  it('list su batchId inesistente/mai inizializzato → array vuoto, mai eccezione', () => {
    expect(listUploadBatchFiles('non-esiste-nessun-batch')).toEqual([]);
  });

  it('cleanup su batchId non valido → no-op, mai eccezione', () => {
    expect(() => cleanupUploadBatch('../../etc')).not.toThrow();
  });
});
