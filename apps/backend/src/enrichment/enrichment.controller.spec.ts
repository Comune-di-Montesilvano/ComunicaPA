import { vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { TraceFormat } from '../entities/enrichment-job.entity.js';
import { EnrichmentController } from './enrichment.controller.js';
import { chunkUploadDir, cleanupChunkedUpload, initChunkedUpload, operatorUploadOwner } from '../campaigns/chunked-upload.util.js';
import { addToUploadBatch, cleanupUploadBatch, UPLOAD_BATCH_ROOT } from './enrichment-batch-upload.util.js';

const OP = { user: { sub: 'op', username: 'op' } } as any;
const OTHER_OP = { user: { sub: 'altro', username: 'altro' } } as any;

describe('EnrichmentController', () => {
  let svc: any;
  let events: any;
  let controller: EnrichmentController;

  beforeEach(() => {
    svc = {
      enqueueBatchMerge: jest.fn(async () => ({ jobId: 'j1' })),
      listJobs: jest.fn(async () => []),
      getJob: jest.fn(async () => ({ id: 'j1' })),
      deleteJob: jest.fn(async () => ({})),
      buildResultZip: jest.fn(async () => Buffer.from('zip')),
      getRow: jest.fn(async () => ({ pdfFilename: 'PROVV_1.pdf', codiceFiscale: 'X', headers: ['indirizzo'], row: {}, override: null })),
      saveRowOverride: jest.fn(async () => ({})),
      dismissWarning: jest.fn(async () => undefined),
      regenerateCsv: jest.fn(async () => ({})),
    };
    events = {
      subscribe: jest.fn(() => jest.fn()), // ritorna una funzione di unsubscribe fittizia
    };
    controller = new EnrichmentController(svc, events);
  });

  it('init: valida filename e totalChunks', () => {
    expect(() => controller.initUpload({ filename: '', totalChunks: 1 }, OP)).toThrow();
    expect(() => controller.initUpload({ filename: 'x.zip', totalChunks: 0 }, OP)).toThrow();
  });

  it('init: sessione intestata all’operatore', () => {
    const { uploadId } = controller.initUpload({ filename: 'x.zip', totalChunks: 1 }, OP);
    const meta = JSON.parse(fs.readFileSync(join(chunkUploadDir(uploadId), 'meta.json'), 'utf8'));
    expect(meta.owner).toBe(operatorUploadOwner(OP.user));
    cleanupChunkedUpload(uploadId);
  });

  it('complete: batchId mancante/non valido → 400, sessione rimossa', async () => {
    for (const batchId of ['non-un-uuid', undefined]) {
      const uploadId = initChunkedUpload('x.zip', 1, operatorUploadOwner(OP.user));
      await expect(controller.completeUpload(uploadId, { batchId }, OP)).rejects.toBeInstanceOf(BadRequestException);
      expect(fs.existsSync(chunkUploadDir(uploadId))).toBe(false);
    }
  });

  it('complete: lotto di un altro operatore o inesistente → 404, lotto intatto, sessione rimossa', async () => {
    const { batchId } = controller.initBatch(OTHER_OP);
    for (const target of [batchId, '11111111-2222-4333-8444-555555555555']) {
      const uploadId = initChunkedUpload('x.zip', 1, operatorUploadOwner(OP.user));
      await expect(controller.completeUpload(uploadId, { batchId: target }, OP)).rejects.toBeInstanceOf(NotFoundException);
      expect(fs.existsSync(chunkUploadDir(uploadId))).toBe(false);
    }
    expect(fs.readdirSync(join(UPLOAD_BATCH_ROOT, batchId))).toEqual(['.batch.json']);
    cleanupUploadBatch(batchId);
  });

  it('complete: pezzo aggiunto al proprio lotto', async () => {
    const { batchId } = controller.initBatch(OP);
    const uploadId = initChunkedUpload('pezzo.zip', 1, operatorUploadOwner(OP.user));
    fs.writeFileSync(join(chunkUploadDir(uploadId), '0.part'), 'zip');
    await expect(controller.completeUpload(uploadId, { batchId }, OP)).resolves.toEqual({ ok: true });
    expect(fs.existsSync(join(UPLOAD_BATCH_ROOT, batchId, '0000_pezzo.zip'))).toBe(true);
    expect(fs.existsSync(chunkUploadDir(uploadId))).toBe(false);
    cleanupUploadBatch(batchId);
  });

  it('complete: uploadId malformato → 400', async () => {
    await expect(controller.completeUpload('upload-inesistente', { batchId: '11111111-1111-1111-1111-111111111111' }, OP)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('complete: sessione upload inesistente → 404', async () => {
    await expect(controller.completeUpload('11111111-2222-4333-8444-555555555555', { batchId: '11111111-1111-1111-1111-111111111111' }, OP)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('complete: sessione di un altro operatore → 404, sessione intatta', async () => {
    const uploadId = initChunkedUpload('x.zip', 1, operatorUploadOwner(OP.user));
    await expect(controller.completeUpload(uploadId, { batchId: '11111111-1111-1111-1111-111111111111' }, OTHER_OP)).rejects.toBeInstanceOf(NotFoundException);
    expect(fs.existsSync(join(chunkUploadDir(uploadId), 'meta.json'))).toBe(true);
    cleanupChunkedUpload(uploadId);
  });

  it('initBatch: ritorna un batchId intestato all’operatore', () => {
    const result = controller.initBatch(OP);
    expect(result.batchId).toMatch(/^[0-9a-f]{8}-/i);
    const meta = JSON.parse(fs.readFileSync(join(UPLOAD_BATCH_ROOT, result.batchId, '.batch.json'), 'utf8'));
    expect(meta.owner).toBe(operatorUploadOwner(OP.user));
    cleanupUploadBatch(result.batchId);
  });

  it('completeBatch: batchId non valido → 400, enqueueBatchMerge non chiamato', async () => {
    await expect(controller.completeBatch('non-un-uuid', { traceFormat: TraceFormat.MAGGIOLI }, OP)).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.enqueueBatchMerge).not.toHaveBeenCalled();
  });

  it('completeBatch: lotto di un altro operatore → 404, lotto intatto', async () => {
    const { batchId } = controller.initBatch(OP);
    await expect(controller.completeBatch(batchId, { traceFormat: TraceFormat.MAGGIOLI }, OTHER_OP)).rejects.toBeInstanceOf(NotFoundException);
    expect(svc.enqueueBatchMerge).not.toHaveBeenCalled();
    expect(fs.existsSync(join(UPLOAD_BATCH_ROOT, batchId, '.batch.json'))).toBe(true);
    cleanupUploadBatch(batchId);
  });

  it('completeBatch: lotto inesistente → 404', async () => {
    await expect(controller.completeBatch('11111111-2222-4333-8444-555555555555', { traceFormat: TraceFormat.MAGGIOLI }, OP)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('completeBatch: traceFormat non valido → blocked, lotto rimosso', async () => {
    const { batchId } = controller.initBatch(OP);
    const result = await controller.completeBatch(batchId, { traceFormat: 'ALTRO' as any }, OP);
    expect(result.blocked).toBe(true);
    expect(fs.existsSync(join(UPLOAD_BATCH_ROOT, batchId))).toBe(false);
  });

  it('completeBatch: nessun file caricato nel batch → blocked, lotto rimosso', async () => {
    const { batchId } = controller.initBatch(OP);
    const result = await controller.completeBatch(batchId, { traceFormat: TraceFormat.MAGGIOLI }, OP);
    expect(result.blocked).toBe(true);
    expect(svc.enqueueBatchMerge).not.toHaveBeenCalled();
    expect(fs.existsSync(join(UPLOAD_BATCH_ROOT, batchId))).toBe(false);
  });

  it('completeBatch: errore di accodamento → blocked, lotto rimosso', async () => {
    svc.enqueueBatchMerge = jest.fn(async () => {
      throw new Error('coda non disponibile');
    });
    const { batchId } = controller.initBatch(OP);
    const tmp = fs.mkdtempSync(join(os.tmpdir(), 'ctrl-batch-'));
    const zipPath = join(tmp, 'a.zip');
    fs.writeFileSync(zipPath, 'zip');
    addToUploadBatch(batchId, zipPath, 'a.zip');
    const result = await controller.completeBatch(batchId, { traceFormat: TraceFormat.MAGGIOLI }, OP);
    expect(result).toEqual({ blocked: true, message: 'coda non disponibile' });
    expect(fs.existsSync(join(UPLOAD_BATCH_ROOT, batchId))).toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('completeBatch: input validi → enqueueBatchMerge chiamato, ritorna jobId subito (nessun merge sincrono)', async () => {
    const { batchId } = controller.initBatch(OP);
    // Simula un file già assemblato nel batch (bypassando l'upload chunked reale).
    const tmp = fs.mkdtempSync(join(os.tmpdir(), 'ctrl-batch-'));
    const zipPath = join(tmp, 'a.zip');
    fs.writeFileSync(zipPath, 'fake-zip-content');
    addToUploadBatch(batchId, zipPath, 'a.zip');

    const result = await controller.completeBatch(batchId, { traceFormat: TraceFormat.MAGGIOLI }, OP);

    expect(result).toEqual({ jobId: 'j1' });
    expect(svc.enqueueBatchMerge).toHaveBeenCalledWith(
      expect.objectContaining({ batchId, zipFilenames: ['a.zip'], traceFormat: TraceFormat.MAGGIOLI }),
    );
    // I pezzi servono ancora al job di merge: il lotto resta, lo pulisce il processor.
    expect(fs.existsSync(join(UPLOAD_BATCH_ROOT, batchId, '0000_a.zip'))).toBe(true);
    // Un secondo complete sullo stesso lotto → 404, nessun secondo job.
    await expect(controller.completeBatch(batchId, { traceFormat: TraceFormat.MAGGIOLI }, OP)).rejects.toBeInstanceOf(NotFoundException);
    expect(svc.enqueueBatchMerge).toHaveBeenCalledTimes(1);
    cleanupUploadBatch(batchId);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('list ritorna {jobs}', async () => {
    await expect(controller.listJobs()).resolves.toEqual({ jobs: [] });
  });

  it('downloadZip: risultato non disponibile → 200 + blocked (mai un 404/500 grezzo)', async () => {
    svc.buildResultZip = jest.fn(async () => null);
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn(), send: jest.fn() };
    await controller.downloadZip('j1', res, { user: { username: 'op', role: 'admin' } } as any);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ blocked: true }));
    expect(res.send).not.toHaveBeenCalled();
  });

  it('downloadZip: risultato disponibile → invia il buffer', async () => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn(), send: jest.fn() };
    await controller.downloadZip('j1', res, { user: { username: 'op', role: 'admin' } } as any);
    expect(res.send).toHaveBeenCalledWith(Buffer.from('zip'));
    expect(res.status).not.toHaveBeenCalled();
  });

  it('stream: job già terminale (DONE) → invia subito evento done e chiude, nessuna subscription', async () => {
    svc.getJob = jest.fn(async () => ({ id: 'j1', status: 'done' }));
    const req: any = { on: jest.fn() };
    const res: any = { setHeader: jest.fn(), write: jest.fn(), end: jest.fn() };

    await controller.streamJob('j1', req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"type":"done"'));
    expect(res.end).toHaveBeenCalled();
    expect(events.subscribe).not.toHaveBeenCalled();
  });

  it('stream: job in corso (processing) → si iscrive e inoltra gli eventi ricevuti', async () => {
    svc.getJob = jest.fn(async () => ({ id: 'j1', status: 'processing' }));
    let capturedHandler: ((e: any) => void) | undefined;
    const unsubscribe = jest.fn();
    events.subscribe = jest.fn((_jobId: string, handler: (e: any) => void) => {
      capturedHandler = handler;
      return unsubscribe;
    });
    const req: any = { on: jest.fn() };
    const res: any = { setHeader: jest.fn(), write: jest.fn(), end: jest.fn() };

    const streamPromise = controller.streamJob('j1', req, res);
    // streamJob fa `await this.svc.getJob(id)` prima di sottoscriversi: serve
    // un tick di microtask perché `capturedHandler` venga popolato prima di usarlo.
    await Promise.resolve();
    // Simula un evento emesso mentre il client è connesso
    capturedHandler?.({ type: 'log', row: 1, pdf: 'a.pdf', detail: 'full', payload: {} });
    capturedHandler?.({ type: 'done' });
    await streamPromise;

    expect(events.subscribe).toHaveBeenCalledWith('j1', expect.any(Function));
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"row":1'));
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('"type":"done"'));
    expect(res.end).toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('stream: disconnessione client → unsubscribe chiamata', async () => {
    svc.getJob = jest.fn(async () => ({ id: 'j1', status: 'processing' }));
    let closeHandler: (() => void) | undefined;
    const unsubscribe = jest.fn();
    events.subscribe = jest.fn(() => unsubscribe);
    const req: any = { on: jest.fn((event: string, cb: () => void) => { if (event === 'close') closeHandler = cb; }) };
    const res: any = { setHeader: jest.fn(), write: jest.fn(), end: jest.fn() };

    const streamPromise = controller.streamJob('j1', req, res);
    // streamJob fa `await this.svc.getJob(id)` prima di registrare l'handler
    // 'close': serve un tick di microtask perché `closeHandler` venga popolato.
    await Promise.resolve();
    closeHandler?.();
    await streamPromise;

    expect(unsubscribe).toHaveBeenCalled();
  });

  it('stream: manda un heartbeat periodico per non far scadere il timeout del reverse proxy su job lunghi senza eventi', async () => {
    vi.useFakeTimers();
    try {
      svc.getJob = jest.fn(async () => ({ id: 'j1', status: 'processing' }));
      let capturedHandler: ((e: any) => void) | undefined;
      events.subscribe = jest.fn((_jobId: string, handler: (e: any) => void) => {
        capturedHandler = handler;
        return jest.fn();
      });
      const req: any = { on: jest.fn() };
      const res: any = { setHeader: jest.fn(), write: jest.fn(), end: jest.fn() };

      const streamPromise = controller.streamJob('j1', req, res);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(31_000); // due tick da 15s

      expect(res.write).toHaveBeenCalledWith(': heartbeat\n\n');
      expect(res.write.mock.calls.filter((c: any) => c[0] === ': heartbeat\n\n').length).toBeGreaterThanOrEqual(2);

      capturedHandler?.({ type: 'done' });
      await streamPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('GET rows/:pdfFilename delega al service', async () => {
    const result = await controller.getRow('j1', 'PROVV_1.pdf');
    expect(svc.getRow).toHaveBeenCalledWith('j1', 'PROVV_1.pdf');
    expect(result.pdfFilename).toBe('PROVV_1.pdf');
  });

  it('PUT rows/:pdfFilename: passa operatore e body al service', async () => {
    const result = await controller.saveRowOverride(
      'j1',
      'PROVV_1.pdf',
      { indirizzo: 'VIA NUOVA', cap: '00100', comune: 'ROMA', provincia: 'RM' },
      { user: { username: 'op' } } as any,
    );
    expect(svc.saveRowOverride).toHaveBeenCalledWith('j1', 'PROVV_1.pdf', { indirizzo: 'VIA NUOVA', cap: '00100', comune: 'ROMA', provincia: 'RM' }, 'op');
    expect(result.blocked).toBeUndefined();
  });

  it('POST rows/:pdfFilename/dismiss: passa operatore al service', async () => {
    const result = await controller.dismissWarning('j1', 'PROVV_1.pdf', { user: { username: 'op' } } as any);
    expect(svc.dismissWarning).toHaveBeenCalledWith('j1', 'PROVV_1.pdf', 'op');
    expect(result).toEqual({ success: true });
  });

  it('POST regenerate-csv delega al service', async () => {
    const result = await controller.regenerateCsv('j1');
    expect(svc.regenerateCsv).toHaveBeenCalledWith('j1');
    expect(result.blocked).toBeUndefined();
  });
});
