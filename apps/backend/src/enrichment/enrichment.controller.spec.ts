import { TraceFormat } from '../entities/enrichment-job.entity';
import { EnrichmentController } from './enrichment.controller';

describe('EnrichmentController', () => {
  let svc: any;
  let controller: EnrichmentController;

  beforeEach(() => {
    svc = {
      createJob: jest.fn(async () => ({ jobId: 'j1' })),
      listJobs: jest.fn(async () => []),
      getJob: jest.fn(async () => ({ id: 'j1' })),
      deleteJob: jest.fn(async () => ({})),
      buildResultZip: jest.fn(async () => Buffer.from('zip')),
    };
    controller = new EnrichmentController(svc);
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
});
