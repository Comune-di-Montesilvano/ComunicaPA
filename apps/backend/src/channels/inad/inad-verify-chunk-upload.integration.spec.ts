import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import * as fs from 'fs';
import { InadVerifyController } from './inad-verify.controller';
import { InadService } from './inad.service';
import { InadVerifyBulkService } from './inad-verify-bulk.service';
import { chunkUploadDir, initChunkedUpload, cleanupChunkedUpload } from '../../campaigns/chunked-upload.util';

/**
 * Terza occorrenza della stessa classe di bug (path traversal su uploadId/
 * index dentro un callback diskStorage di multer) — questa volta sui 4
 * endpoint operatore (campaigns/enrichment/io-services/inad-verify) che
 * condividono lo stesso pattern del già corretto external-api chunk().
 * `InadVerifyController` è scelto come prova rappresentativa via vero giro
 * HTTP (stesso motivo già documentato in
 * external-api-http-status.integration.spec.ts: un test a livello
 * controller che chiama il metodo direttamente non eserciterebbe MAI i
 * callback `destination`/`filename` di multer, dove viveva il bug reale).
 * Gli altri 3 controller (campaigns/enrichment/io-services) riusano
 * ESATTAMENTE le stesse funzioni condivise (`safeChunkUploadDir()`/
 * `isValidChunkIndex()`, chunked-upload.util.ts) con lo stesso identico
 * codice di callback — coperti da unit test dedicati su quelle funzioni
 * condivise (chunked-upload.util.spec.ts) invece di ripetere 3 volte lo
 * stesso boot Nest+supertest, che non aggiungerebbe nulla di nuovo.
 *
 * Nessun guard globale (JwtAuthGuard/RolesGuard) è collegato qui: sono
 * bound via APP_GUARD in AppModule, non a livello di controller/decorator
 * — un TestingModule con solo questo controller (stesso approccio già
 * usato per l'external-api) non li applica, `@Roles()` resta metadata
 * inerte. Corretto per l'obiettivo di questo spec (provare il comportamento
 * dei callback diskStorage), non un modo per bypassare l'autenticazione
 * reale in produzione.
 */
describe('InadVerifyController — upload chunk (integration, path traversal fix)', () => {
  let app: INestApplication;
  let inadService: { extractDigitalAddress: jest.Mock };
  let bulkSvc: { createJob: jest.Mock; getStatus: jest.Mock; getResultCsv: jest.Mock };
  const createdUploadIds: string[] = [];

  beforeAll(async () => {
    inadService = { extractDigitalAddress: jest.fn() };
    bulkSvc = { createJob: jest.fn(), getStatus: jest.fn(), getResultCsv: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [InadVerifyController],
      providers: [
        { provide: InadService, useValue: inadService },
        { provide: InadVerifyBulkService, useValue: bulkSvc },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    for (const uploadId of createdUploadIds) {
      cleanupChunkedUpload(uploadId);
    }
  });

  it('chunk (successo, uploadId/index legittimi) → il file viene scritto dentro la cartella di upload prevista', async () => {
    const uploadId = initChunkedUpload('elenco.csv', 1);
    createdUploadIds.push(uploadId);

    await request(app.getHttpServer())
      .post(`/admin/inad-verify/verify-bulk/upload/chunk/${uploadId}/0`)
      .attach('chunk', Buffer.from('cf;esito\n'), 'chunk.bin')
      .expect(201);

    expect(fs.existsSync(`${chunkUploadDir(uploadId)}/0.part`)).toBe(true);
  });

  /**
   * Prova diretta anti-crash: se il fix non ci fosse (o regredisse), il
   * throw sincrono di chunkUploadDir() dentro il callback `destination`
   * sfuggirebbe come uncaughtException — il processo Node del worker Jest
   * stesso morirebbe a metà suite (comportamento realmente osservato prima
   * del fix, riprodotto manualmente durante lo sviluppo). Il fatto che
   * questo test — e tutti quelli dopo, nello stesso processo — completino
   * regolarmente è la prova che il processo non è mai crashato.
   */
  it('chunk con uploadId path-traversal → risposta di errore pulita (400), processo Jest sopravvive, nessun file scritto fuori da CHUNK_ROOT', async () => {
    const maliciousUploadId = '..%2F..%2F..%2F..%2Ftmp%2Fcomunicapa-uploads-traversal-poc-inad';
    const res = await request(app.getHttpServer())
      .post(`/admin/inad-verify/verify-bulk/upload/chunk/${maliciousUploadId}/0`)
      .attach('chunk', Buffer.from('payload malevolo'), 'chunk.bin');

    expect(res.status).toBe(400);
    expect(fs.existsSync('/tmp/comunicapa-uploads-traversal-poc-inad')).toBe(false);
  });

  it('chunk con index path-traversal → risposta di errore pulita (400), nessun file scritto col nome malevolo', async () => {
    const uploadId = initChunkedUpload('elenco.csv', 1);
    createdUploadIds.push(uploadId);
    const maliciousIndex = '..%2F..%2Fevil';

    const res = await request(app.getHttpServer())
      .post(`/admin/inad-verify/verify-bulk/upload/chunk/${uploadId}/${maliciousIndex}`)
      .attach('chunk', Buffer.from('payload malevolo'), 'chunk.bin');

    expect(res.status).toBe(400);
    expect(fs.existsSync(`${chunkUploadDir(uploadId)}/evil.part`)).toBe(false);
  });

  it('complete (successo) → chiama bulkSvc.createJob dopo aver riassemblato i chunk', async () => {
    const uploadId = initChunkedUpload('elenco.csv', 1);
    fs.writeFileSync(`${chunkUploadDir(uploadId)}/0.part`, 'cf;esito\nRSSMRA80A01H501U;trovato\n');
    bulkSvc.createJob.mockResolvedValue({ jobId: 'job-1' });

    const res = await request(app.getHttpServer())
      .post(`/admin/inad-verify/verify-bulk/upload/complete/${uploadId}`)
      .send({ hasHeaders: true, cfColumn: 'cf' })
      .expect(200);

    expect(res.body).toEqual({ jobId: 'job-1' });
    expect(bulkSvc.createJob).toHaveBeenCalled();
  });
});
