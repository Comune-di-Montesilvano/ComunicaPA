import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import request from 'supertest';
import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { DomicileVerificationController } from './domicile-verification.controller.js';
import { DomicileVerificationService } from './domicile-verification.service.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { DomicileVerificationJob, DomicileVerificationJobStatus } from '../../entities/domicile-verification-job.entity.js';
import { IoServiceConfig } from '../../entities/io-service-config.entity.js';
import { InadService } from '../inad/inad.service.js';
import { RegistroImpreseVerifyQueueService } from '../registro-imprese/registro-imprese-verify-queue.service.js';
import { APP_IO_VERIFY_BULK_QUEUE } from '../../io-services/app-io-verify-bulk-job.types.js';
import { CHUNK_ROOT, MAX_CHUNK_SIZE_BYTES, safeChunkUploadDir } from '../../campaigns/chunked-upload.util.js';

/**
 * Giro HTTP reale (supertest) su DomicileVerificationController: controller,
 * RolesGuard globale, ValidationPipe come in main.ts, callback diskStorage di
 * multer e DomicileVerificationService VERO (ownership in findVisibleJob) —
 * mockati solo repository, code BullMQ e servizi esterni (INAD, Registro
 * Imprese). L'utente arriva da un middleware di test (header x-user/x-role) al
 * posto di JwtAuthGuard: qui si verifica cosa succede DOPO l'autenticazione.
 */

const JOB_A = '11111111-2222-4333-8444-555555555555';
const JOB_LEGACY = '22222222-3333-4444-8555-666666666666';
const IO_SERVICE_ID = '33333333-4444-4555-8666-777777777777';
const CSV_ASSENTI = 'cf\nRSSMRA80A01H501U\n';

const ADMIN = { 'x-user': 'amministratore', 'x-role': 'admin' };
const OP_A = { 'x-user': 'operatore-a', 'x-role': 'user' };
const OP_B = { 'x-user': 'operatore-b', 'x-role': 'user' };

function makeJob(id: string, createdBy: string | null): DomicileVerificationJob {
  return {
    id,
    createdBy,
    status: DomicileVerificationJobStatus.DONE,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    totalRows: 1,
    cfFisicoTotal: 1,
    pivaTotal: 0,
    inadBatches: [],
    inadFoundMap: {},
    appIoDone: true,
    appIoProcessedRows: 1,
    appIoPresentCount: 0,
    registroImpreseTotal: 0,
    registroImpreseDone: 0,
    registroImpreseFoundCount: 0,
    errorMessage: null,
    resultAssentiCsv: CSV_ASSENTI,
    resultAppIoCsv: CSV_ASSENTI,
    resultInadCsv: CSV_ASSENTI,
    resultRegistroImpreseCsv: CSV_ASSENTI,
    resultAggregatoCsv: CSV_ASSENTI,
  } as unknown as DomicileVerificationJob;
}

/** Repository in memoria con la stessa semantica di findOneBy/find({ where }) di TypeORM (uguaglianza campo per campo). */
function matches(job: DomicileVerificationJob, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => (job as unknown as Record<string, unknown>)[k] === v);
}

describe('DomicileVerificationController (integration: path traversal, limiti upload, ownership)', () => {
  let app: INestApplication;
  let tempRoot: string;
  let target: string;
  let service: DomicileVerificationService;
  const jobs: DomicileVerificationJob[] = [makeJob(JOB_A, 'operatore-a'), makeJob(JOB_LEGACY, null)];
  const jobRepo = {
    findOneBy: jest.fn(async (where: Record<string, unknown>) => jobs.find((j) => matches(j, where)) ?? null),
    find: jest.fn(async ({ where }: { where: Record<string, unknown> }) => jobs.filter((j) => matches(j, where))),
    delete: jest.fn(async () => ({ affected: 1 })),
    update: jest.fn(async () => ({ affected: 1 })),
  };
  const createdUploads: string[] = [];

  const server = () => app.getHttpServer();

  async function initUpload(filename = 'tracciato.csv', totalChunks = 1): Promise<string> {
    const res = await request(server()).post('/admin/domicile-verification/verify/upload/init').set(OP_A).send({ filename, totalChunks }).expect(201);
    createdUploads.push(res.body.uploadId);
    return res.body.uploadId as string;
  }

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'domicile-int-'));
    // Cartella esistente FUORI dalla radice chunk: bersaglio di ogni tentativo
    // di traversal (multer scrive solo se la destination esiste già).
    target = join(tempRoot, 'bersaglio');
    fs.mkdirSync(target);

    const moduleRef = await Test.createTestingModule({
      controllers: [DomicileVerificationController],
      providers: [
        DomicileVerificationService,
        { provide: getRepositoryToken(DomicileVerificationJob), useValue: jobRepo },
        { provide: getRepositoryToken(IoServiceConfig), useValue: { findOneBy: jest.fn() } },
        { provide: InadService, useValue: {} },
        { provide: RegistroImpreseVerifyQueueService, useValue: {} },
        { provide: getQueueToken(APP_IO_VERIFY_BULK_QUEUE), useValue: { add: jest.fn() } },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: any, _res: any, next: any) => {
      if (req.headers['x-user']) {
        req.user = { sub: req.headers['x-user'], username: req.headers['x-user'], role: req.headers['x-role'], type: 'operator' };
      }
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    service = moduleRef.get(DomicileVerificationService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    for (const id of createdUploads) {
      const dir = safeChunkUploadDir(id);
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe('POST verify/upload/chunk/:uploadId/:index — path traversal', () => {
    // Percorso relativo dalla radice chunk al bersaglio: join(radice, uploadId)
    // senza validazione risolverebbe esattamente in `target`.
    const relFromChunkDir = () => relative(CHUNK_ROOT, target);

    it('sanity: il payload relativo punta davvero al bersaglio', () => {
      expect(join(CHUNK_ROOT, relFromChunkDir())).toBe(target);
    });

    it.each([
      ['../ relativo', () => encodeURIComponent(relFromChunkDir())],
      ['%2e%2e%2f (decodificato da Express)', () => relFromChunkDir().split('/').map((p) => (p === '..' ? '%2e%2e' : encodeURIComponent(p))).join('%2f')],
      ['doppia codifica %252e%252e%252f', () => encodeURIComponent(encodeURIComponent(relFromChunkDir()))],
      ['path assoluto', () => encodeURIComponent(target)],
    ])('uploadId %s → 400, nessun file scritto nel bersaglio', async (_label, makeId) => {
      const res = await request(server())
        .post(`/admin/domicile-verification/verify/upload/chunk/${makeId()}/0`)
        .set(OP_A)
        .attach('chunk', Buffer.from('cf\n'), 'blob');

      expect(res.status).toBe(400);
      expect(fs.readdirSync(target)).toEqual([]);
    });

    it.each([
      ['../ relativo', (rel: string) => encodeURIComponent(rel)],
      ['%2e%2e%2f', (rel: string) => rel.split('/').map((p) => (p === '..' ? '%2e%2e' : encodeURIComponent(p))).join('%2f')],
      ['path assoluto', (_rel: string) => encodeURIComponent(join(target, 'evil'))],
    ])('index %s → 400, nessun file fuori dalla cartella di upload', async (_label, makeIndex) => {
      const uploadId = await initUpload();
      const dir = safeChunkUploadDir(uploadId)!;
      const rel = relative(dir, join(target, 'evil'));

      const res = await request(server())
        .post(`/admin/domicile-verification/verify/upload/chunk/${uploadId}/${makeIndex(rel)}`)
        .set(OP_A)
        .attach('chunk', Buffer.from('cf\n'), 'blob');

      expect(res.status).toBe(400);
      expect(fs.readdirSync(target)).toEqual([]);
      expect(fs.readdirSync(dir)).toEqual(['meta.json']);
    });

    it('uploadId UUID valido ma sessione inesistente → 404', async () => {
      await request(server())
        .post('/admin/domicile-verification/verify/upload/chunk/44444444-5555-4666-8777-888888888888/0')
        .set(OP_A)
        .attach('chunk', Buffer.from('cf\n'), 'blob')
        .expect(404);
    });

    it('sessione di operatore-a usata da operatore-b → 404, nessun chunk scritto', async () => {
      const uploadId = await initUpload();
      const dir = safeChunkUploadDir(uploadId)!;
      await request(server())
        .post(`/admin/domicile-verification/verify/upload/chunk/${uploadId}/0`)
        .set(OP_B)
        .attach('chunk', Buffer.from('cf\n'), 'blob')
        .expect(404);
      expect(fs.readdirSync(dir)).toEqual(['meta.json']);
    });

    it('init: filename con ../ ridotto a basename nei metadati della sessione', async () => {
      const uploadId = await initUpload('../../../../app/dist/main.js');
      const meta = JSON.parse(fs.readFileSync(join(safeChunkUploadDir(uploadId)!, 'meta.json'), 'utf8'));
      expect(meta.filename).toBe('main.js');
    });
  });

  describe('POST verify/upload/chunk — limite MAX_CHUNK_SIZE_BYTES', () => {
    it('chunk di MAX_CHUNK_SIZE_BYTES + 1 byte → 413, nessun .part lasciato su disco', async () => {
      const uploadId = await initUpload();
      const dir = safeChunkUploadDir(uploadId)!;

      const res = await request(server())
        .post(`/admin/domicile-verification/verify/upload/chunk/${uploadId}/0`)
        .set(OP_A)
        .attach('chunk', Buffer.alloc(MAX_CHUNK_SIZE_BYTES + 1, 0x61), 'blob');

      expect(res.status).toBe(413);
      expect(fs.readdirSync(dir)).toEqual(['meta.json']);
    });

    it('chunk di esattamente MAX_CHUNK_SIZE_BYTES → 201, salvato come 0.part', async () => {
      const uploadId = await initUpload();
      const dir = safeChunkUploadDir(uploadId)!;

      await request(server())
        .post(`/admin/domicile-verification/verify/upload/chunk/${uploadId}/0`)
        .set(OP_A)
        .attach('chunk', Buffer.alloc(MAX_CHUNK_SIZE_BYTES, 0x61), 'blob')
        .expect(201, { ok: true });

      expect(fs.statSync(join(dir, '0.part')).size).toBe(MAX_CHUNK_SIZE_BYTES);
    });
  });

  describe('POST verify/upload/complete/:uploadId', () => {
    const body = { hasHeaders: true, cfColumn: 'cf', ioServiceId: IO_SERVICE_ID };

    it('uploadId con ../ → 400, nessun job creato', async () => {
      const createJob = jest.spyOn(service, 'createJob');
      await request(server())
        .post(`/admin/domicile-verification/verify/upload/complete/${encodeURIComponent('../../../../etc')}`)
        .set(OP_A)
        .send(body)
        .expect(400);

      expect(createJob).not.toHaveBeenCalled();
    });

    it('sessione di operatore-a completata da operatore-b → 404, sessione intatta, nessun job', async () => {
      const createJob = jest.spyOn(service, 'createJob');
      const uploadId = await initUpload();
      await request(server())
        .post(`/admin/domicile-verification/verify/upload/complete/${uploadId}`)
        .set(OP_B)
        .send(body)
        .expect(404);
      expect(createJob).not.toHaveBeenCalled();
      expect(fs.readdirSync(safeChunkUploadDir(uploadId)!)).toEqual(['meta.json']);
    });

    it('elaborazione a valle fallita → esito bloccato, sessione chunk comunque rimossa', async () => {
      jest.spyOn(service, 'createJob').mockRejectedValue(new Error('colonna CF assente'));
      const uploadId = await initUpload('tracciato.csv', 1);
      await request(server())
        .post(`/admin/domicile-verification/verify/upload/chunk/${uploadId}/0`)
        .set(OP_A)
        .attach('chunk', Buffer.from(CSV_ASSENTI), 'blob')
        .expect(201);

      const res = await request(server())
        .post(`/admin/domicile-verification/verify/upload/complete/${uploadId}`)
        .set(OP_A)
        .send(body)
        .expect(201);

      expect(res.body.blocked).toBe(true);
      expect(fs.existsSync(safeChunkUploadDir(uploadId)!)).toBe(false);
    });

    it('flusso completo: job intestato all’operatore autenticato, sessione chunk rimossa', async () => {
      const createJob = jest.spyOn(service, 'createJob').mockResolvedValue({ jobId: JOB_A });
      const uploadId = await initUpload('tracciato.csv', 1);
      await request(server())
        .post(`/admin/domicile-verification/verify/upload/chunk/${uploadId}/0`)
        .set(OP_A)
        .attach('chunk', Buffer.from(CSV_ASSENTI), 'blob')
        .expect(201);

      await request(server())
        .post(`/admin/domicile-verification/verify/upload/complete/${uploadId}`)
        .set(OP_A)
        .send(body)
        .expect(201, { jobId: JOB_A });

      expect(createJob).toHaveBeenCalledWith(expect.objectContaining({ csvContent: CSV_ASSENTI, createdBy: 'operatore-a' }));
      expect(fs.existsSync(safeChunkUploadDir(uploadId)!)).toBe(false);
    });
  });

  describe('jobs/:id — id non UUID', () => {
    it.each([
      encodeURIComponent('../../etc/passwd'),
      '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '%252e%252e%252fetc',
      encodeURIComponent('/etc/passwd'),
    ])('GET jobs/%s/assenti.csv → 400 da ParseUUIDPipe, repository mai interrogato', async (id) => {
      await request(server()).get(`/admin/domicile-verification/jobs/${id}/assenti.csv`).set(ADMIN).expect(400);
      expect(jobRepo.findOneBy).not.toHaveBeenCalled();
    });
  });

  describe('ownership: job di operatore-a', () => {
    const variants = ['assenti', 'app-io', 'inad', 'registro-imprese', 'aggregato'];

    it('operatore-b (user): stato → 404', async () => {
      await request(server()).get(`/admin/domicile-verification/jobs/${JOB_A}`).set(OP_B).expect(404);
    });

    it.each(variants)('operatore-b (user): download %s.csv → 404', async (variant) => {
      const res = await request(server()).get(`/admin/domicile-verification/jobs/${JOB_A}/${variant}.csv`).set(OP_B);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('RSSMRA80A01H501U');
    });

    it('operatore-b (user): DELETE → 404, nessuna cancellazione', async () => {
      await request(server()).delete(`/admin/domicile-verification/jobs/${JOB_A}`).set(OP_B).expect(404);
      expect(jobRepo.delete).not.toHaveBeenCalled();
    });

    it('operatore-b (user): elenco senza i job altrui', async () => {
      const res = await request(server()).get('/admin/domicile-verification/jobs').set(OP_B).expect(200);
      expect(res.body.jobs).toEqual([]);
    });

    it('operatore-b (user): skip-inad (solo admin) → 403', async () => {
      await request(server()).post(`/admin/domicile-verification/jobs/${JOB_A}/skip-inad`).set(OP_B).expect(403);
      expect(jobRepo.findOneBy).not.toHaveBeenCalled();
    });

    it('operatore-a (proprietario): stato, CSV e cancellazione consentiti', async () => {
      await request(server()).get(`/admin/domicile-verification/jobs/${JOB_A}`).set(OP_A).expect(200);
      const csv = await request(server()).get(`/admin/domicile-verification/jobs/${JOB_A}/assenti.csv`).set(OP_A).expect(200);
      expect(csv.text).toBe(CSV_ASSENTI);
      expect(csv.headers['content-disposition']).toBe('attachment; filename="verifica_domicili_assenti_11111111.csv"');
      await request(server()).delete(`/admin/domicile-verification/jobs/${JOB_A}`).set(OP_A).expect(200);
      expect(jobRepo.delete).toHaveBeenCalledWith(JOB_A);
    });

    it('operatore-a: job senza proprietario (precedente al campo) → 404', async () => {
      await request(server()).get(`/admin/domicile-verification/jobs/${JOB_LEGACY}`).set(OP_A).expect(404);
    });

    it('admin: vede job altrui e senza proprietario', async () => {
      await request(server()).get(`/admin/domicile-verification/jobs/${JOB_A}`).set(ADMIN).expect(200);
      await request(server()).get(`/admin/domicile-verification/jobs/${JOB_LEGACY}/aggregato.csv`).set(ADMIN).expect(200);
      const list = await request(server()).get('/admin/domicile-verification/jobs').set(ADMIN).expect(200);
      expect(list.body.jobs.map((j: { id: string }) => j.id)).toEqual([JOB_A, JOB_LEGACY]);
    });

    it('senza utente (nessun token) → 403 dal RolesGuard', async () => {
      await request(server()).get(`/admin/domicile-verification/jobs/${JOB_A}`).expect(403);
    });
  });
});
