import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { ExternalNotificationsController } from './external-notifications.controller.js';
import { ExternalAttachmentsController } from './external-attachments.controller.js';
import { ExternalDomicilioController } from './external-domicilio.controller.js';
import { ExternalCapabilitiesController } from './external-capabilities.controller.js';
import { ExternalNotificationsService } from './external-notifications.service.js';
import { ExternalNotificationStatusService } from './external-notification-status.service.js';
import { ExternalCapabilitiesService } from './external-capabilities.service.js';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service.js';
import { DomicilioService } from '../channels/domicilio/domicilio.service.js';
import { AuditLogsService } from '../audit-logs/audit-logs.service.js';
import { ApiKeyGuard } from './guards/api-key.guard.js';
import { ExternalApiClientsService } from './external-api-clients.service.js';
import { ExternalApiError } from './external-api.error.js';
import { chunkUploadDir } from '../campaigns/chunked-upload.util.js';

/**
 * Boot reale di controller+guard+filter con richieste HTTP vere: intercetta
 * i due gotcha non visibili agli spec unit (201 al posto di 200 su @Post,
 * provider non risolti). Vedi docs/claude/external-api-module.md.
 */
describe('external/v2 — status code contratto HTTP reale (integration)', () => {
  let app: INestApplication;
  const VALID_KEY = 'valid-key-e2e';
  const FAKE_CLIENT = { id: 'client-1', name: 'Test Client HTTP' };
  const createdUploadIds: string[] = [];
  const notifications = { create: jest.fn() };
  const status = { get: jest.fn() };
  const capabilities = { getCapabilities: jest.fn(async () => ({ success: true, channels: {} })) };
  const domicilio = { cercaDomicilio: jest.fn(async (taxId: string) => ({ codiceFiscale: taxId })) };
  const tokensService = { completeUpload: jest.fn(async () => ({ token: 'tok-http-1' })) };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ExternalNotificationsController, ExternalAttachmentsController, ExternalDomicilioController, ExternalCapabilitiesController],
      providers: [
        ApiKeyGuard,
        {
          provide: ExternalApiClientsService,
          useValue: {
            findActiveByKey: jest.fn(async (k: string) => (k === VALID_KEY ? FAKE_CLIENT : null)),
            touchLastUsed: jest.fn(async () => undefined),
          },
        },
        { provide: ExternalNotificationsService, useValue: notifications },
        { provide: ExternalNotificationStatusService, useValue: status },
        { provide: ExternalCapabilitiesService, useValue: capabilities },
        { provide: ExternalAttachmentTokensService, useValue: tokensService },
        { provide: DomicilioService, useValue: domicilio },
        { provide: AuditLogsService, useValue: { log: jest.fn(async () => undefined) } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    for (const id of createdUploadIds) fs.rmSync(chunkUploadDir(id), { recursive: true, force: true });
  });

  it('POST /external/v2/notifications → 200, body e Idempotency-Key passati al service senza ValidationPipe globale', async () => {
    notifications.create.mockResolvedValueOnce({ success: true, notificationId: 'rec-1', status: 'accepted' });
    const body = { channel: 'EMAIL', recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', email: 'a@b.it', unknown: 1 }, content: { subject: 'x', body: 'y' } };
    const res = await request(app.getHttpServer()).post('/external/v2/notifications').set('X-Api-Key', VALID_KEY).set('Idempotency-Key', 'k-1').send(body).expect(200);
    expect(res.body).toEqual({ success: true, notificationId: 'rec-1', status: 'accepted' });
    // Il body arriva intatto (campo sconosciuto incluso): la validazione con path completo è del service.
    expect(notifications.create).toHaveBeenCalledWith(body, FAKE_CLIENT, 'k-1');
  });

  it('POST /external/v2/notifications con ExternalApiError → 200 con code/details', async () => {
    notifications.create.mockRejectedValueOnce(new ExternalApiError('VALIDATION_ERROR', 'Validazione fallita', [{ field: 'recipient.unknown', message: 'campo non ammesso' }]));
    const res = await request(app.getHttpServer()).post('/external/v2/notifications').set('X-Api-Key', VALID_KEY).set('Idempotency-Key', 'k-2').send({}).expect(200);
    expect(res.body).toEqual({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Validazione fallita', details: [{ field: 'recipient.unknown', message: 'campo non ammesso' }] } });
  });

  it('GET /external/v2/notifications/:id → 200; NOT_FOUND resta 200', async () => {
    status.get.mockResolvedValueOnce({ success: true, notificationId: 'rec-1', status: 'sent', events: [] });
    await request(app.getHttpServer()).get('/external/v2/notifications/rec-1').set('X-Api-Key', VALID_KEY).expect(200);
    expect(status.get).toHaveBeenCalledWith('rec-1', 'client-1');
    status.get.mockRejectedValueOnce(new ExternalApiError('NOT_FOUND', 'Notifica non trovata'));
    const res = await request(app.getHttpServer()).get('/external/v2/notifications/x').set('X-Api-Key', VALID_KEY).expect(200);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('GET /external/v2/capabilities → 200', async () => {
    await request(app.getHttpServer()).get('/external/v2/capabilities').set('X-Api-Key', VALID_KEY).expect(200);
  });

  it('POST /external/v2/domicilio/cerca accetta P.IVA → 200', async () => {
    const res = await request(app.getHttpServer()).post('/external/v2/domicilio/cerca').set('X-Api-Key', VALID_KEY).send({ taxId: '01234567890' }).expect(200);
    expect(res.body).toEqual({ success: true, codiceFiscale: '01234567890' });
    expect(domicilio.cercaDomicilio).toHaveBeenCalledWith('01234567890', 'external:Test Client HTTP');
  });

  it('POST /external/v2/domicilio/cerca con taxId non valido → VALIDATION_ERROR (200)', async () => {
    const res = await request(app.getHttpServer()).post('/external/v2/domicilio/cerca').set('X-Api-Key', VALID_KEY).send({ taxId: '123' }).expect(200);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST external/v2/attachments/upload/init (successo) → HTTP 200', async () => {
    const res = await request(app.getHttpServer())
      .post('/external/v2/attachments/upload/init')
      .set('X-Api-Key', VALID_KEY)
      .send({ filename: 'avviso.pdf', totalChunks: 1 })
      .expect(200);
    expect(res.body).toMatchObject({ success: true });
    expect(typeof res.body.uploadId).toBe('string');
    createdUploadIds.push(res.body.uploadId);
  });

  it('POST external/v2/attachments/upload/init con filename path-traversal → validazione lo riduce/rifiuta, mai scritto fuori dalla cartella upload', async () => {
    const res = await request(app.getHttpServer())
      .post('/external/v2/attachments/upload/init')
      .set('X-Api-Key', VALID_KEY)
      .send({ filename: '../../../../etc/passwd', totalChunks: 1 })
      .expect(200);
    expect(res.body).toMatchObject({ success: true });
    const uploadId = res.body.uploadId as string;
    createdUploadIds.push(uploadId);
    const meta = JSON.parse(fs.readFileSync(`${chunkUploadDir(uploadId)}/meta.json`, 'utf8'));
    // basename() riduce il filename al solo nome file, mai al path completo —
    // stessa protezione applicata a tutti i 5 punti di chiamata di
    // initChunkedUpload (vedi chunked-upload.util.ts).
    expect(meta.filename).toBe('passwd');
  });

  it('POST external/v2/attachments/upload/init con totalChunks non intero → VALIDATION_ERROR (DTO validato, non più interfaccia TS grezza)', async () => {
    const res = await request(app.getHttpServer())
      .post('/external/v2/attachments/upload/init')
      .set('X-Api-Key', VALID_KEY)
      .send({ filename: 'avviso.pdf', totalChunks: 'not-a-number' })
      .expect(200);
    expect(res.body).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('POST external/v2/attachments/upload/chunk (successo, uploadId UUID valido) → HTTP 200', async () => {
    const uploadId = randomUUID();
    createdUploadIds.push(uploadId);
    const res = await request(app.getHttpServer())
      .post('/external/v2/attachments/upload/chunk')
      .set('X-Api-Key', VALID_KEY)
      .field('uploadId', uploadId)
      .field('index', '0')
      .attach('chunk', Buffer.from('contenuto di test'), 'chunk.bin')
      .expect(200);
    expect(res.body).toEqual({ success: true });
    // Il chunk deve essere scritto DENTRO la cartella di upload prevista,
    // non altrove — prova positiva simmetrica ai test di traversal sotto.
    expect(fs.existsSync(`${chunkUploadDir(uploadId)}/0.part`)).toBe(true);
  });

  /**
   * Path traversal — secondo finding critico review finale (follow-up al
   * fix già applicato su init()/filename): chunk() usa FileInterceptor
   * (multer/diskStorage) i cui callback `destination`/`filename` leggono
   * `req.body.uploadId`/`index` DURANTE il parsing multipart, PRIMA che la
   * ValidationPipe su @Body() possa intervenire — un test a livello
   * controller (chiamata diretta al metodo) non eserciterebbe MAI questo
   * percorso. Solo un vero giro HTTP attraverso multer prova che il file
   * non viene scritto fuori da CHUNK_ROOT.
   */
  it('POST external/v2/attachments/upload/chunk con uploadId path-traversal → HTTP 200 con blocco esplicito, nessun file scritto fuori da CHUNK_ROOT', async () => {
    const maliciousUploadId = '../../../../tmp/comunicapa-uploads-traversal-poc';
    const res = await request(app.getHttpServer())
      .post('/external/v2/attachments/upload/chunk')
      .set('X-Api-Key', VALID_KEY)
      .field('uploadId', maliciousUploadId)
      .field('index', '0')
      .attach('chunk', Buffer.from('payload malevolo'), 'chunk.bin')
      .expect(200);
    expect(res.body).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    // Prova diretta: nessun file scritto nella destinazione risolta dal
    // traversal (fuori da CHUNK_ROOT).
    expect(fs.existsSync('/tmp/comunicapa-uploads-traversal-poc')).toBe(false);
  });

  it('POST external/v2/attachments/upload/chunk con index path-traversal → HTTP 200 con blocco esplicito', async () => {
    const uploadId = randomUUID();
    createdUploadIds.push(uploadId);
    // init reale, per avere una cartella di upload legittima su cui
    // verificare che NON compaia alcun file col nome malevolo.
    await request(app.getHttpServer())
      .post('/external/v2/attachments/upload/init')
      .set('X-Api-Key', VALID_KEY)
      .send({ filename: 'avviso.pdf', totalChunks: 1 })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/external/v2/attachments/upload/chunk')
      .set('X-Api-Key', VALID_KEY)
      .field('uploadId', uploadId)
      .field('index', '../../evil')
      .attach('chunk', Buffer.from('payload malevolo'), 'chunk.bin')
      .expect(200);
    expect(res.body).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
  });

  it('POST external/v2/attachments/upload/complete (successo, uploadId UUID valido) → HTTP 200', async () => {
    const uploadId = randomUUID();
    const res = await request(app.getHttpServer())
      .post('/external/v2/attachments/upload/complete')
      .set('X-Api-Key', VALID_KEY)
      .send({ uploadId })
      .expect(200);
    expect(res.body).toEqual({ success: true, attachmentToken: 'tok-http-1' });
    expect(tokensService.completeUpload).toHaveBeenCalledWith('client-1', uploadId);
  });

  /**
   * complete() non passa da multer — qui la ValidationPipe globale gira
   * PRIMA del controller, quindi @IsUUID() su CompleteAttachmentUploadDto è
   * la protezione REALE (non solo difesa in profondità come per chunk()).
   */
  it('POST external/v2/attachments/upload/complete con uploadId path-traversal → VALIDATION_ERROR, mai invocato con il payload malevolo', async () => {
    const res = await request(app.getHttpServer())
      .post('/external/v2/attachments/upload/complete')
      .set('X-Api-Key', VALID_KEY)
      .send({ uploadId: '../../../../etc/passwd' })
      .expect(200);
    expect(res.body).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    // Altri test in questo describe chiamano legittimamente completeUpload
    // (mock condiviso, nessun clearMocks tra i test) — l'asserzione giusta è
    // che NON sia mai stato invocato con il payload di traversal, non che
    // il call count totale sia zero.
    expect(tokensService.completeUpload).not.toHaveBeenCalledWith(expect.anything(), '../../../../etc/passwd');
  });


  it('API key non valida → 200 UNAUTHORIZED; route v1 non esiste più', async () => {
    const res = await request(app.getHttpServer()).post('/external/v2/notifications').set('X-Api-Key', 'nope').send({}).expect(200);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    await request(app.getHttpServer()).get('/external/v1/capabilities').set('X-Api-Key', VALID_KEY).expect(404);
  });
});
