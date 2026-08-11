import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import * as fs from 'fs';
import { ExternalNotificationsController } from './external-notifications.controller';
import { ExternalAttachmentsController } from './external-attachments.controller';
import { ExternalDomicilioController } from './external-domicilio.controller';
import { ExternalApiService } from './external-api.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service';
import { DomicilioService } from '../channels/domicilio/domicilio.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ExternalApiClientsService } from './external-api-clients.service';
import { chunkUploadDir } from '../campaigns/chunked-upload.util';

/**
 * Task 12 (review follow-up) — Nessuno spec in external-api/ prima d'ora
 * asserisce sul vero status code HTTP: tutti istanziano i controller con
 * `new X(...)` e verificano solo il body ritornato — un `@HttpCode` mancante
 * (bug reale trovato/corretto, vedi task-12-report.md) non fa fallire NESSUNO
 * di quegli spec, perché la risposta HTTP vera (con lo status code deciso da
 * Nest/Express) non viene mai prodotta in quei test.
 *
 * Questo spec fa il contrario: boot di un vero modulo Nest (controller +
 * guard reali, solo i service esterni mockati, stesso principio già usato
 * dagli spec unit di questa cartella ma cablato attraverso il vero grafo
 * Nest invece che `new Controller(...)`) e richieste HTTP reali via
 * supertest — così `@HttpCode`/il default Nest sono davvero esercitati.
 *
 * Scelta deliberata: NON importo `ExternalApiModule` per intero (richiede
 * `TypeOrmModule.forFeature`, quindi una connessione DB reale/datasource
 * mockato più pesante da wire-are senza guadagnare nulla sul punto da
 * verificare, il codice HTTP). Uso invece
 * `Test.createTestingModule({ controllers: [...], providers: [...] })` con
 * i controller REALI di produzione e i loro service diretti mockati — stesso
 * identico controller/guard/filter compilati da Nest, zero DB coinvolto.
 */
describe('external/v1 — status code contratto HTTP reale (integration)', () => {
  let app: INestApplication;
  let externalApiService: { createAndLaunch: jest.Mock };
  let campaignsService: { findOne: jest.Mock };
  let tokensService: { completeUpload: jest.Mock };
  let domicilioService: { cercaDomicilio: jest.Mock };
  let auditLogsService: { log: jest.Mock };
  let clientsService: { findActiveByKey: jest.Mock; touchLastUsed: jest.Mock };
  const createdUploadIds: string[] = [];

  const VALID_KEY = 'valid-key-e2e';
  const FAKE_CLIENT = { id: 'client-1', name: 'Test Client HTTP' };

  beforeAll(async () => {
    externalApiService = {
      createAndLaunch: jest.fn().mockResolvedValue({ success: true, campaignId: 'camp-http-1', status: 'QUEUED' }),
    };
    campaignsService = { findOne: jest.fn() };
    tokensService = { completeUpload: jest.fn().mockResolvedValue({ token: 'tok-http-1' }) };
    domicilioService = {
      cercaDomicilio: jest.fn().mockResolvedValue({
        codiceFiscale: 'RSSMRA80A01H501U',
        inad: { success: true, found: false },
        appIo: { success: true, active: false },
        anpr: { success: true, found: false },
      }),
    };
    auditLogsService = { log: jest.fn().mockResolvedValue(undefined) };
    clientsService = {
      findActiveByKey: jest.fn().mockImplementation(async (key: string) => (key === VALID_KEY ? FAKE_CLIENT : null)),
      touchLastUsed: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ExternalNotificationsController, ExternalAttachmentsController, ExternalDomicilioController],
      providers: [
        ApiKeyGuard,
        { provide: ExternalApiClientsService, useValue: clientsService },
        { provide: ExternalApiService, useValue: externalApiService },
        { provide: CampaignsService, useValue: campaignsService },
        { provide: ExternalAttachmentTokensService, useValue: tokensService },
        { provide: DomicilioService, useValue: domicilioService },
        { provide: AuditLogsService, useValue: auditLogsService },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Stesso ValidationPipe globale configurato in main.ts — senza questo,
    // la pipeline reale testata non rispecchierebbe quella di produzione.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    for (const uploadId of createdUploadIds) {
      fs.rmSync(chunkUploadDir(uploadId), { recursive: true, force: true });
    }
  });

  it('POST external/v1/notifications (successo) → HTTP 200, non 201 (default Nest per POST)', async () => {
    const res = await request(app.getHttpServer())
      .post('/external/v1/notifications')
      .set('X-Api-Key', VALID_KEY)
      .send({ channelType: 'EMAIL', codiceFiscale: 'RSSMRA80A01H501U', email: 'test@example.com', extraData: {} })
      .expect(200);
    expect(res.body).toEqual({ success: true, campaignId: 'camp-http-1', status: 'QUEUED' });
  });

  it('POST external/v1/attachments/upload/init (successo) → HTTP 200', async () => {
    const res = await request(app.getHttpServer())
      .post('/external/v1/attachments/upload/init')
      .set('X-Api-Key', VALID_KEY)
      .send({ filename: 'avviso.pdf', totalChunks: 1 })
      .expect(200);
    expect(res.body).toMatchObject({ success: true });
    expect(typeof res.body.uploadId).toBe('string');
    createdUploadIds.push(res.body.uploadId);
  });

  it('POST external/v1/attachments/upload/chunk (successo) → HTTP 200', async () => {
    const uploadId = 'test-upload-http-status-spec';
    createdUploadIds.push(uploadId);
    const res = await request(app.getHttpServer())
      .post('/external/v1/attachments/upload/chunk')
      .set('X-Api-Key', VALID_KEY)
      .field('uploadId', uploadId)
      .field('index', '0')
      .attach('chunk', Buffer.from('contenuto di test'), 'chunk.bin')
      .expect(200);
    expect(res.body).toEqual({ success: true });
  });

  it('POST external/v1/attachments/upload/complete (successo) → HTTP 200', async () => {
    const res = await request(app.getHttpServer())
      .post('/external/v1/attachments/upload/complete')
      .set('X-Api-Key', VALID_KEY)
      .send({ uploadId: 'test-upload-http-status-spec' })
      .expect(200);
    expect(res.body).toEqual({ success: true, attachmentToken: 'tok-http-1' });
  });

  it('POST external/v1/domicilio/cerca (successo) → HTTP 200', async () => {
    const res = await request(app.getHttpServer())
      .post('/external/v1/domicilio/cerca')
      .set('X-Api-Key', VALID_KEY)
      .send({ codiceFiscale: 'RSSMRA80A01H501U' })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(auditLogsService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'EXTERNAL_DOMICILIO_SEARCH', details: { codiceFiscale: 'RSSMRA80A01H501U' } }),
    );
  });

  it('POST external/v1/notifications con API key invalida → resta HTTP 200 (filtro eccezioni, mai 401)', async () => {
    const res = await request(app.getHttpServer())
      .post('/external/v1/notifications')
      .set('X-Api-Key', 'key-completamente-sbagliata')
      .send({ channelType: 'EMAIL', codiceFiscale: 'RSSMRA80A01H501U', email: 'test@example.com', extraData: {} })
      .expect(200);
    expect(res.body).toEqual({ success: false, error: { code: 'UNAUTHORIZED', message: 'API key non valida o revocata' } });
  });
});
