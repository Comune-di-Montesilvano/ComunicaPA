import 'reflect-metadata';
import { it } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import request from 'supertest';
import AdmZip from 'adm-zip';
import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { SignedAttachmentsController } from './signed-attachments.controller.js';
import { SignedAttachmentsService } from './signed-attachments.service.js';
import { RemoteSignService } from './remote-sign.service.js';
import { ArubaSignClient } from './aruba-sign.client.js';
import { REMOTE_SIGN_QUEUE } from './remote-sign-job.types.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CampaignAccessInterceptor } from '../campaigns/campaign-access.interceptor.js';
import { Campaign, CampaignStatus } from '../entities/campaign.entity.js';
import { Recipient } from '../entities/recipient.entity.js';
import { RemoteSignJob } from '../entities/remote-sign-job.entity.js';
import { SignatureVerificationJobStatus } from '../entities/signature-verification-job.entity.js';
import { SignatureVerificationBulkService } from '../signature-verification/signature-verification-bulk.service.js';
import { SignatureVerificationService } from '../signature-verification/signature-verification.service.js';
import { AppSettingsService } from '../settings/app-settings.service.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';
import { getUnsignedBackupDir, getUploadsDir } from '../attachments/attachment-paths.js';
import { CHUNK_ROOT, initChunkedUpload, MAX_CHUNK_SIZE_BYTES, safeChunkUploadDir } from '../campaigns/chunked-upload.util.js';

/**
 * Giro HTTP reale (supertest) su SignedAttachmentsController: controller,
 * RolesGuard e CampaignAccessInterceptor globali come in AppModule,
 * ValidationPipe come in main.ts, callback diskStorage di multer,
 * SignedAttachmentsService e RemoteSignService VERI (permessi in
 * assertCanModify, scrittura allegati via safeAttachmentPath/replaceAttachment).
 * Mockati solo repository, coda BullMQ, client Aruba, verifica firma e audit.
 * ATTACHMENTS_PATH punta a una cartella temporanea; l'utente arriva da un
 * middleware di test (header x-user/x-role) al posto di JwtAuthGuard.
 */

const BOZZA_A = '11111111-2222-4333-8444-555555555555';
const INVIATA_A = '22222222-3333-4444-8555-666666666666';

const ADMIN = { 'x-user': 'amministratore', 'x-role': 'admin' };
const OP_A = { 'x-user': 'operatore-a', 'x-role': 'user' };
const OP_B = { 'x-user': 'operatore-b', 'x-role': 'user' };
const FIRMATARIO = { 'x-user': 'firmatario', 'x-role': 'user' };

const CHANNEL_CONFIG = { attachments: [{ key: 'allegato', label: 'Allegato' }] };
const campaigns: Record<string, Partial<Campaign>> = {
  [BOZZA_A]: { id: BOZZA_A, name: 'Bozza A', channelType: 'SEND', status: CampaignStatus.DRAFT, createdBy: 'operatore-a', signerUsername: 'firmatario', isTest: false, channelConfig: CHANNEL_CONFIG } as Partial<Campaign>,
  [INVIATA_A]: { id: INVIATA_A, name: 'Inviata A', channelType: 'SEND', status: CampaignStatus.COMPLETED, createdBy: 'operatore-a', signerUsername: null, isTest: false, channelConfig: CHANNEL_CONFIG } as Partial<Campaign>,
};

function binaryParser(res: request.Response, cb: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

/**
 * AdmZip.addFile normalizza i nomi (toglie `../` e `/` iniziali): per avere
 * nell'archivio i nomi malevoli VERI si aggiungono segnaposto della stessa
 * lunghezza e si sostituiscono i byte del nome in header locale e central
 * directory (il CRC copre solo i dati, resta valido).
 */
function zipWithRawEntryNames(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  const placeholders = Object.keys(files).map((name, i) => [name, String.fromCharCode(65 + i).repeat(name.length)] as const);
  for (const [name, placeholder] of placeholders) zip.addFile(placeholder, Buffer.from(files[name]!));
  const buf = zip.toBuffer();
  for (const [name, placeholder] of placeholders) {
    const from = Buffer.from(placeholder);
    let at = buf.indexOf(from);
    while (at !== -1) {
      Buffer.from(name).copy(buf, at);
      at = buf.indexOf(from, at + from.length);
    }
  }
  return buf;
}

describe('SignedAttachmentsController (integration: path traversal, limiti upload, permessi)', () => {
  let app: INestApplication;
  let tempRoot: string;
  let originalAttachmentsPath: string | undefined;
  const createdUploads: string[] = [];

  const campaignRepo = {
    findOneBy: jest.fn(async ({ id }: { id: string }) => campaigns[id] ?? null),
    findOne: jest.fn(async ({ where: { id } }: { where: { id: string } }) => campaigns[id] ?? null),
  };
  // Destinatari PENDING con firma non valida: un nome legittimo e nomi
  // malevoli dal CSV che puntano fuori dalla cartella uploads della campagna.
  const recipientRepo = {
    find: jest.fn(async () => [
      { extraData: { allegato: 'avviso.pdf' }, signatureCheck: { valid: false } },
      { extraData: { allegato: '../fuori.pdf' }, signatureCheck: { valid: false } },
      { extraData: { allegato: '../../segreto.pdf' }, signatureCheck: { valid: false } },
      { extraData: { allegato: '/etc/passwd.pdf' }, signatureCheck: { valid: false } },
    ]),
  };
  const verificationBulk = {
    getLatestStatus: jest.fn(async () => ({ status: SignatureVerificationJobStatus.DONE })),
    startForCampaign: jest.fn(async () => undefined),
  };
  const verification = { verify: jest.fn(async () => ({ valid: false })) };
  const audit = { log: jest.fn(async () => undefined) };

  const server = () => app.getHttpServer();
  const base = (id: string) => `/admin/campaigns/${id}/signed-attachments/upload`;

  async function upload(campaignId: string, filename: string, content: Buffer, who = OP_A): Promise<string> {
    const init = await request(server()).post(`${base(campaignId)}/init`).set(who).send({ filename, totalChunks: 1 }).expect(200);
    const uploadId = init.body.uploadId as string;
    createdUploads.push(uploadId);
    await request(server()).post(`${base(campaignId)}/chunk/${uploadId}/0`).set(who).attach('chunk', content, 'blob').expect(200);
    return uploadId;
  }

  beforeAll(async () => {
    originalAttachmentsPath = process.env['ATTACHMENTS_PATH'];
    tempRoot = mkdtempSync(join(tmpdir(), 'signed-att-int-'));
    process.env['ATTACHMENTS_PATH'] = tempRoot;

    const moduleRef = await Test.createTestingModule({
      controllers: [SignedAttachmentsController],
      providers: [
        SignedAttachmentsService,
        RemoteSignService,
        { provide: getRepositoryToken(Campaign), useValue: campaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: recipientRepo },
        { provide: getRepositoryToken(RemoteSignJob), useValue: { exists: jest.fn(async () => false) } },
        { provide: getQueueToken(REMOTE_SIGN_QUEUE), useValue: { add: jest.fn() } },
        { provide: ArubaSignClient, useValue: {} },
        { provide: SignatureVerificationBulkService, useValue: verificationBulk },
        { provide: SignatureVerificationService, useValue: verification },
        { provide: AppSettingsService, useValue: { get: jest.fn() } },
        { provide: ConfigService, useValue: { get: () => 'segreto-di-test-lungo-almeno-32-caratteri' } },
        { provide: AuditLogsService, useValue: audit },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_INTERCEPTOR, useClass: CampaignAccessInterceptor },
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
  });

  beforeEach(() => {
    // Stato su disco ricreato a ogni test: allegato da firmare nella bozza,
    // file "esca" fuori dalla cartella uploads della campagna.
    rmSync(join(tempRoot), { recursive: true, force: true });
    fs.mkdirSync(getUploadsDir(BOZZA_A), { recursive: true });
    fs.writeFileSync(join(getUploadsDir(BOZZA_A), 'avviso.pdf'), '%PDF-1.4 originale');
    fs.writeFileSync(join(tempRoot, 'uploads', 'fuori.pdf'), '%PDF-1.4 fuori');
    fs.writeFileSync(join(tempRoot, 'segreto.pdf'), '%PDF-1.4 segreto');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await app.close();
    for (const id of createdUploads) {
      const dir = safeChunkUploadDir(id);
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    rmSync(tempRoot, { recursive: true, force: true });
    if (originalAttachmentsPath === undefined) delete process.env['ATTACHMENTS_PATH'];
    else process.env['ATTACHMENTS_PATH'] = originalAttachmentsPath;
  });

  describe('GET signature/unsigned.zip', () => {
    it.each([
      encodeURIComponent('../../etc'),
      '%2e%2e%2f%2e%2e%2fetc',
      encodeURIComponent('/etc/passwd'),
    ])('id %s → 400 da ParseUUIDPipe, campagna mai letta', async (id) => {
      await request(server()).get(`/admin/campaigns/${id}/signature/unsigned.zip`).set(ADMIN).expect(400);
      expect(campaignRepo.findOneBy).not.toHaveBeenCalled();
    });

    it('nomi allegato dal CSV con ../ o path assoluto esclusi: lo ZIP contiene solo file della campagna', async () => {
      const res = await request(server())
        .get(`/admin/campaigns/${BOZZA_A}/signature/unsigned.zip`)
        .set(OP_A)
        .buffer(true)
        .parse(binaryParser)
        .expect(200);

      expect(res.headers['content-type']).toBe('application/zip');
      const entries = new AdmZip(res.body as Buffer).getEntries().map((e) => e.entryName);
      expect(entries).toEqual(['avviso.pdf']);
    });

    it.each([
      ['admin', ADMIN],
      ['firmatario indicato', FIRMATARIO],
    ])('%s → 200', async (_label, who) => {
      await request(server()).get(`/admin/campaigns/${BOZZA_A}/signature/unsigned.zip`).set(who).expect(200);
    });

    it('operatore-b su bozza altrui → 404 (CampaignAccessInterceptor), nessun accesso al servizio', async () => {
      await request(server()).get(`/admin/campaigns/${BOZZA_A}/signature/unsigned.zip`).set(OP_B).expect(404);
      expect(campaignRepo.findOneBy).not.toHaveBeenCalled();
      expect(recipientRepo.find).not.toHaveBeenCalled();
    });

    it('operatore-b su campagna inviata altrui → 403 + audit ATTACHMENT_ACCESS_DENIED', async () => {
      await request(server()).get(`/admin/campaigns/${INVIATA_A}/signature/unsigned.zip`).set(OP_B).expect(403);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ATTACHMENT_ACCESS_DENIED', operator: 'operatore-b', campaignId: INVIATA_A }));
      expect(recipientRepo.find).not.toHaveBeenCalled();
    });
  });

  describe('POST signed-attachments/upload/chunk/:uploadId/:index — path traversal', () => {
    const target = () => join(tempRoot, 'uploads');

    it.each([
      ['../ relativo', () => encodeURIComponent(relative(CHUNK_ROOT, target()))],
      ['%2e%2e%2f', () => relative(CHUNK_ROOT, target()).split('/').map((p) => (p === '..' ? '%2e%2e' : encodeURIComponent(p))).join('%2f')],
      ['doppia codifica', () => encodeURIComponent(encodeURIComponent(relative(CHUNK_ROOT, target())))],
      ['path assoluto', () => encodeURIComponent(target())],
    ])('uploadId %s → 400, nessun file scritto nel bersaglio', async (_label, makeId) => {
      const before = fs.readdirSync(target()).sort();
      const res = await request(server())
        .post(`${base(BOZZA_A)}/chunk/${makeId()}/0`)
        .set(OP_A)
        .attach('chunk', Buffer.from('%PDF-1.4'), 'blob');

      expect(res.status).toBe(400);
      expect(fs.readdirSync(target()).sort()).toEqual(before);
    });

    it.each([
      ['../ relativo', (rel: string) => encodeURIComponent(rel)],
      ['%2e%2e%2f', (rel: string) => rel.split('/').map((p) => (p === '..' ? '%2e%2e' : encodeURIComponent(p))).join('%2f')],
    ])('index %s → 400, nessun file fuori dalla cartella di upload', async (_label, makeIndex) => {
      const init = await request(server()).post(`${base(BOZZA_A)}/init`).set(OP_A).send({ filename: 'avviso.pdf', totalChunks: 1 }).expect(200);
      createdUploads.push(init.body.uploadId);
      const dir = safeChunkUploadDir(init.body.uploadId)!;
      const before = fs.readdirSync(target()).sort();

      const res = await request(server())
        .post(`${base(BOZZA_A)}/chunk/${init.body.uploadId}/${makeIndex(relative(dir, join(target(), 'evil')))}`)
        .set(OP_A)
        .attach('chunk', Buffer.from('%PDF-1.4'), 'blob');

      expect(res.status).toBe(400);
      expect(fs.readdirSync(target()).sort()).toEqual(before);
      expect(fs.readdirSync(dir)).toEqual(['meta.json']);
    });
  });

  describe('POST signed-attachments/upload/chunk — limite MAX_CHUNK_SIZE_BYTES', () => {
    it('chunk di MAX_CHUNK_SIZE_BYTES + 1 byte → 413, nessun .part lasciato su disco', async () => {
      const init = await request(server()).post(`${base(BOZZA_A)}/init`).set(OP_A).send({ filename: 'firmati.zip', totalChunks: 1 }).expect(200);
      createdUploads.push(init.body.uploadId);
      const dir = safeChunkUploadDir(init.body.uploadId)!;

      const res = await request(server())
        .post(`${base(BOZZA_A)}/chunk/${init.body.uploadId}/0`)
        .set(OP_A)
        .attach('chunk', Buffer.alloc(MAX_CHUNK_SIZE_BYTES + 1, 0x61), 'blob');

      expect(res.status).toBe(413);
      expect(fs.readdirSync(dir)).toEqual(['meta.json']);
    });

    it('chunk di esattamente MAX_CHUNK_SIZE_BYTES → 200', async () => {
      const uploadId = await upload(BOZZA_A, 'firmati.zip', Buffer.alloc(MAX_CHUNK_SIZE_BYTES, 0x61));
      expect(fs.statSync(join(safeChunkUploadDir(uploadId)!, '0.part')).size).toBe(MAX_CHUNK_SIZE_BYTES);
    });
  });

  describe('POST signed-attachments/upload/complete/:uploadId', () => {
    it('PDF singolo con filename ../: sostituito SOLO l’allegato nella cartella della campagna', async () => {
      const uploadId = await upload(BOZZA_A, '../../../avviso.pdf', Buffer.from('%PDF-1.4 firmato'));

      const res = await request(server()).post(`${base(BOZZA_A)}/complete/${uploadId}`).set(OP_A).expect(200);

      expect(res.body).toEqual({ replaced: 1, rejected: [] });
      expect(fs.readFileSync(join(getUploadsDir(BOZZA_A), 'avviso.pdf'), 'utf8')).toBe('%PDF-1.4 firmato');
      expect(fs.readFileSync(join(getUnsignedBackupDir(BOZZA_A), 'avviso.pdf'), 'utf8')).toBe('%PDF-1.4 originale');
      expect(fs.existsSync(join(tempRoot, 'avviso.pdf'))).toBe(false);
    });

    it('sessione chunk rimossa dopo complete', async () => {
      const uploadId = await upload(BOZZA_A, 'avviso.pdf', Buffer.from('%PDF-1.4 firmato'));
      await request(server()).post(`${base(BOZZA_A)}/complete/${uploadId}`).set(OP_A).expect(200);
      expect(fs.existsSync(safeChunkUploadDir(uploadId)!)).toBe(false);
    });

    it('sessione chunk rimossa anche quando l’elaborazione fallisce (ZIP non valido)', async () => {
      const uploadId = await upload(BOZZA_A, 'firmati.zip', Buffer.from('non è uno zip'));
      const res = await request(server()).post(`${base(BOZZA_A)}/complete/${uploadId}`).set(OP_A).expect(200);
      expect(res.body).toEqual({ error: 'ZIP non valido o danneggiato' });
      expect(fs.existsSync(safeChunkUploadDir(uploadId)!)).toBe(false);
    });

    it('ZIP con sottocartelle legittime: voce appiattita e abbinata all’allegato', async () => {
      const zip = new AdmZip();
      zip.addFile('firmati/avviso.pdf', Buffer.from('%PDF-1.4 firmato-sottocartella'));
      const uploadId = await upload(BOZZA_A, 'firmati.zip', zip.toBuffer());

      await request(server()).post(`${base(BOZZA_A)}/complete/${uploadId}`).set(OP_A).expect(200, { replaced: 1, rejected: [] });
      expect(fs.readFileSync(join(getUploadsDir(BOZZA_A), 'avviso.pdf'), 'utf8')).toBe('%PDF-1.4 firmato-sottocartella');
    });

    // yauzl rifiuta già all'apertura le voci con `..` o path assoluto: lo
    // ZIP intero viene scartato, nessun file sostituito né scritto altrove.
    it('ZIP con voci ../ e path assoluti: archivio rifiutato, nulla scritto fuori dalla campagna', async () => {
      const zipBuffer = zipWithRawEntryNames({
        '../../../../avviso.pdf': '%PDF-1.4 firmato-zip',
        '../../segreto.pdf': '%PDF-1.4 sovrascritto',
        '/tmp/assoluto.pdf': '%PDF-1.4 assoluto',
      });
      // Il test non è vacuo solo se le voci malevole sono davvero nell'archivio.
      expect(new AdmZip(zipBuffer).getEntries().map((e) => e.rawEntryName.toString('utf8')).sort()).toEqual(
        ['../../../../avviso.pdf', '../../segreto.pdf', '/tmp/assoluto.pdf'].sort(),
      );
      const uploadId = await upload(BOZZA_A, 'firmati.zip', zipBuffer);

      const res = await request(server()).post(`${base(BOZZA_A)}/complete/${uploadId}`).set(OP_A).expect(200);

      expect(res.body).toEqual({ error: 'ZIP non valido o danneggiato' });
      expect(fs.readFileSync(join(getUploadsDir(BOZZA_A), 'avviso.pdf'), 'utf8')).toBe('%PDF-1.4 originale');
      expect(fs.readFileSync(join(tempRoot, 'segreto.pdf'), 'utf8')).toBe('%PDF-1.4 segreto');
      expect(fs.readFileSync(join(tempRoot, 'uploads', 'fuori.pdf'), 'utf8')).toBe('%PDF-1.4 fuori');
      expect(fs.existsSync('/tmp/assoluto.pdf')).toBe(false);
    });

    it('operatore-b su campagna inviata altrui → 403 prima di assemblare (nessun file assemblato)', async () => {
      const uploadId = await upload(INVIATA_A, 'avviso.pdf', Buffer.from('%PDF-1.4'), OP_B);

      await request(server()).post(`${base(INVIATA_A)}/complete/${uploadId}`).set(OP_B).expect(403);

      // Nessun file assemblato e sessione comunque rimossa (cleanup in finally).
      expect(fs.existsSync(safeChunkUploadDir(uploadId)!)).toBe(false);
      expect(verificationBulk.startForCampaign).not.toHaveBeenCalled();
    });

    it('operatore-b su bozza altrui: init, chunk e complete → 404 (CampaignAccessInterceptor)', async () => {
      await request(server()).post(`${base(BOZZA_A)}/init`).set(OP_B).send({ filename: 'avviso.pdf', totalChunks: 1 }).expect(404);
      const uploadId = await upload(INVIATA_A, 'avviso.pdf', Buffer.from('%PDF-1.4'), OP_B);
      await request(server()).post(`${base(BOZZA_A)}/chunk/${uploadId}/0`).set(OP_B).attach('chunk', Buffer.from('%PDF-1.4'), 'blob').expect(404);
      await request(server()).post(`${base(BOZZA_A)}/complete/${uploadId}`).set(OP_B).expect(404);
      expect(fs.readFileSync(join(getUploadsDir(BOZZA_A), 'avviso.pdf'), 'utf8')).toBe('%PDF-1.4 originale');
    });

    it('admin su bozza altrui → consentito', async () => {
      const uploadId = await upload(BOZZA_A, 'avviso.pdf', Buffer.from('%PDF-1.4 firmato-admin'), ADMIN);
      await request(server()).post(`${base(BOZZA_A)}/complete/${uploadId}`).set(ADMIN).expect(200, { replaced: 1, rejected: [] });
    });

    it('id campagna non UUID → 400', async () => {
      await request(server()).post(`${base(encodeURIComponent('../../etc'))}/complete/44444444-5555-4666-8777-888888888888`).set(OP_A).expect(400);
    });

    it('uploadId con ../ → 400, nessun file letto né scritto', async () => {
      const res = await request(server())
        .post(`${base(BOZZA_A)}/complete/${encodeURIComponent('../../../../etc')}`)
        .set(OP_A);

      expect(res.status).toBe(400);
      expect(fs.readFileSync(join(getUploadsDir(BOZZA_A), 'avviso.pdf'), 'utf8')).toBe('%PDF-1.4 originale');
      expect(verificationBulk.startForCampaign).not.toHaveBeenCalled();
    });

    it('uploadId UUID senza sessione → 404', async () => {
      await request(server()).post(`${base(BOZZA_A)}/complete/44444444-5555-4666-8777-888888888888`).set(OP_A).expect(404);
    });
  });

  describe('sessione di upload legata all’operatore che l’ha aperta', () => {
    it('sessione di operatore-a usata da un altro operatore (admin) → chunk e complete 404, sessione intatta', async () => {
      const uploadId = await upload(BOZZA_A, 'avviso.pdf', Buffer.from('%PDF-1.4 firmato-a'));
      const dir = safeChunkUploadDir(uploadId)!;

      await request(server()).post(`${base(BOZZA_A)}/chunk/${uploadId}/1`).set(ADMIN).attach('chunk', Buffer.from('%PDF-1.4 altro'), 'blob').expect(404);
      await request(server()).post(`${base(BOZZA_A)}/complete/${uploadId}`).set(ADMIN).expect(404);

      expect(fs.readdirSync(dir).sort()).toEqual(['0.part', 'meta.json']);
      expect(fs.readFileSync(join(getUploadsDir(BOZZA_A), 'avviso.pdf'), 'utf8')).toBe('%PDF-1.4 originale');

      // Il proprietario la completa normalmente.
      await request(server()).post(`${base(BOZZA_A)}/complete/${uploadId}`).set(OP_A).expect(200, { replaced: 1, rejected: [] });
    });

    it('sessione creata prima del campo owner (meta senza owner) → accettata', async () => {
      // Sessione aperta senza owner (come prima del campo): initChunkedUpload senza il terzo argomento.
      const uploadId = initChunkedUpload('avviso.pdf', 1);
      createdUploads.push(uploadId);
      await request(server()).post(`${base(BOZZA_A)}/chunk/${uploadId}/0`).set(ADMIN).attach('chunk', Buffer.from('%PDF-1.4 firmato-legacy'), 'blob').expect(200);

      await request(server()).post(`${base(BOZZA_A)}/complete/${uploadId}`).set(ADMIN).expect(200, { replaced: 1, rejected: [] });
    });

    it('sessione inesistente e sessione altrui: stessa risposta sul chunk', async () => {
      const uploadId = await upload(BOZZA_A, 'avviso.pdf', Buffer.from('%PDF-1.4'));
      const altrui = await request(server()).post(`${base(BOZZA_A)}/chunk/${uploadId}/1`).set(ADMIN).attach('chunk', Buffer.from('x'), 'blob');
      const inesistente = await request(server()).post(`${base(BOZZA_A)}/chunk/44444444-5555-4666-8777-888888888888/0`).set(ADMIN).attach('chunk', Buffer.from('x'), 'blob');
      expect(altrui.status).toBe(404);
      expect(inesistente.status).toBe(404);
      expect(altrui.body).toEqual(inesistente.body);
    });
  });
});
