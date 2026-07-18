import { TraceFormat } from '../entities/enrichment-job.entity';
import { EnrichmentController } from './enrichment.controller';

describe('EnrichmentController', () => {
  let svc: any;
  let events: any;
  let controller: EnrichmentController;

  beforeEach(() => {
    svc = {
      createJob: jest.fn(async () => ({ jobId: 'j1' })),
      listJobs: jest.fn(async () => []),
      getJob: jest.fn(async () => ({ id: 'j1' })),
      deleteJob: jest.fn(async () => ({})),
      buildResultZip: jest.fn(async () => Buffer.from('zip')),
    };
    events = {
      subscribe: jest.fn(() => jest.fn()), // ritorna una funzione di unsubscribe fittizia
    };
    controller = new EnrichmentController(svc, events);
  });

  it('init: valida filename e totalChunks', () => {
    expect(() => controller.initUpload({ filename: '', totalChunks: 1 })).toThrow();
    expect(() => controller.initUpload({ filename: 'x.zip', totalChunks: 0 })).toThrow();
  });

  it('complete: traceFormat non valido → blocked (mai eccezione non-2xx)', async () => {
    const result = await controller.completeUpload('upload-inesistente', { traceFormat: 'ALTRO' as any }, { user: { username: 'op' } } as any);
    expect(result.blocked).toBe(true);
  });

  it('complete: sessione upload inesistente → blocked', async () => {
    const result = await controller.completeUpload('upload-inesistente', { traceFormat: TraceFormat.MAGGIOLI }, { user: { username: 'op' } } as any);
    expect(result.blocked).toBe(true);
  });

  it('list ritorna {jobs}', async () => {
    await expect(controller.listJobs()).resolves.toEqual({ jobs: [] });
  });

  it('downloadZip: risultato non disponibile → 200 + blocked (mai un 404/500 grezzo)', async () => {
    svc.buildResultZip = jest.fn(async () => null);
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn(), send: jest.fn() };
    await controller.downloadZip('j1', res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ blocked: true }));
    expect(res.send).not.toHaveBeenCalled();
  });

  it('downloadZip: risultato disponibile → invia il buffer', async () => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn(), send: jest.fn() };
    await controller.downloadZip('j1', res);
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
});
