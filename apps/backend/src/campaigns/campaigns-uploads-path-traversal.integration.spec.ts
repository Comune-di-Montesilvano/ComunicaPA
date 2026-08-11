import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { OperatorDirectoryService } from '../operator-directory/operator-directory.service';
import { CampaignContentCorrectionService } from './campaign-content-correction.service';
import { CampaignBulkRetryService } from './campaign-bulk-retry.service';
import { getUploadsDir } from '../attachments/attachment-paths';

/**
 * Quarta occorrenza della stessa classe di bug (path traversal dentro un
 * callback `destination`/`filename` di multer diskStorage, eseguito PRIMA di
 * qualunque pipe Nest) — questa volta su `:id` (campagna) invece di
 * `uploadId`/`index`. Vero giro HTTP via supertest: un test a livello
 * controller che chiama il metodo direttamente non eserciterebbe mai i
 * callback diskStorage, dove viveva il bug reale (stesso motivo già
 * documentato in inad-verify-chunk-upload.integration.spec.ts).
 *
 * Nessun guard globale (JwtAuthGuard/RolesGuard) è collegato qui: sono bound
 * via APP_GUARD in AppModule, non a livello di controller/decorator — un
 * TestingModule con solo questo controller non li applica. Corretto per
 * l'obiettivo di questo spec (comportamento dei callback diskStorage), non
 * un modo per bypassare l'autenticazione reale in produzione.
 */
describe('CampaignsController — upload draft-csv/attachments (integration, path traversal fix)', () => {
  let app: INestApplication;
  let tempRoot: string;
  let originalAttachmentsPath: string | undefined;
  let campaignsService: Record<string, jest.Mock>;

  const LEGIT_ID = '11111111-2222-4333-8444-555555555555';

  beforeAll(async () => {
    originalAttachmentsPath = process.env['ATTACHMENTS_PATH'];
    tempRoot = mkdtempSync(join(tmpdir(), 'campaigns-upload-test-'));
    process.env['ATTACHMENTS_PATH'] = tempRoot;

    campaignsService = {
      assertDraftForAttachments: jest.fn().mockResolvedValue(undefined),
      finalizeAttachments: jest.fn().mockResolvedValue({
        uploaded: 1,
        discarded: 0,
        attachmentsExpected: 1,
        attachmentsPresent: 1,
        filenames: ['evil.pdf'],
      }),
      findOne: jest.fn().mockResolvedValue({ id: LEGIT_ID, name: 'Campagna Test' }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [CampaignsController],
      providers: [
        { provide: CampaignsService, useValue: campaignsService },
        { provide: AuditLogsService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: OperatorDirectoryService, useValue: { resolveMany: jest.fn().mockResolvedValue({}) } },
        { provide: CampaignContentCorrectionService, useValue: {} },
        { provide: CampaignBulkRetryService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Nessun guard globale collegato (vedi commento sopra) — i controller si
    // aspettano comunque `req.user` (`@Req() req: Request & { user:
    // JwtOperatorPayload }`), normalmente popolato da JwtAuthGuard in prod.
    app.use((req: any, _res: any, next: any) => {
      req.user = { username: 'test-operator', role: 'admin', type: 'operator' };
      next();
    });
    await app.init();
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Ripulisce eventuale dir campagna legittima creata da un test precedente
    rmSync(getUploadsDir(LEGIT_ID), { recursive: true, force: true });
  });

  afterAll(async () => {
    await app.close();
    rmSync(tempRoot, { recursive: true, force: true });
    if (originalAttachmentsPath === undefined) {
      delete process.env['ATTACHMENTS_PATH'];
    } else {
      process.env['ATTACHMENTS_PATH'] = originalAttachmentsPath;
    }
  });

  describe('POST :id/recipients/draft-csv', () => {
    it('id path-traversal → 400, nessuna directory creata fuori da ATTACHMENTS_PATH', async () => {
      const maliciousId = '..%2F..%2F..%2F..%2Ftmp%2Fcomunicapa-draft-csv-poc';

      const res = await request(app.getHttpServer())
        .post(`/admin/campaigns/${maliciousId}/recipients/draft-csv`)
        .attach('file', Buffer.from('cf;nome\n'), 'draft.csv');

      expect(res.status).toBe(400);
      expect(fs.existsSync('/tmp/comunicapa-draft-csv-poc')).toBe(false);
    });

    it('id UUID legittimo → 201, file scritto nella cartella di upload prevista', async () => {
      const res = await request(app.getHttpServer())
        .post(`/admin/campaigns/${LEGIT_ID}/recipients/draft-csv`)
        .attach('file', Buffer.from('cf;nome\n'), 'draft.csv')
        .expect(201);

      expect(res.body).toEqual({ ok: true });
      expect(fs.existsSync(join(getUploadsDir(LEGIT_ID), 'draft_recipients.csv'))).toBe(true);
      expect(campaignsService.assertDraftForAttachments).toHaveBeenCalledWith(LEGIT_ID);
    });
  });

  describe('POST :id/attachments', () => {
    it('id path-traversal → 400, nessuna directory creata fuori da ATTACHMENTS_PATH', async () => {
      const maliciousId = '..%2F..%2F..%2F..%2Ftmp%2Fcomunicapa-attachments-poc';

      const res = await request(app.getHttpServer())
        .post(`/admin/campaigns/${maliciousId}/attachments`)
        .attach('files', Buffer.from('%PDF-1.4'), 'doc.pdf');

      expect(res.status).toBe(400);
      expect(fs.existsSync('/tmp/comunicapa-attachments-poc')).toBe(false);
    });

    it('originalname path-traversal → sanificato con basename() prima di scrivere su disco', async () => {
      await request(app.getHttpServer())
        .post(`/admin/campaigns/${LEGIT_ID}/attachments`)
        .attach('files', Buffer.from('%PDF-1.4'), '../../../../evil.pdf')
        .expect(201);

      const dir = getUploadsDir(LEGIT_ID);
      expect(fs.existsSync(join(dir, 'evil.pdf'))).toBe(true);
      // Nessun file scritto fuori dalla cartella di upload della campagna
      expect(fs.existsSync(join(tempRoot, 'evil.pdf'))).toBe(false);
    });

    it('id UUID legittimo + filename normale → 201, comportamento invariato', async () => {
      const res = await request(app.getHttpServer())
        .post(`/admin/campaigns/${LEGIT_ID}/attachments`)
        .attach('files', Buffer.from('%PDF-1.4'), 'documento.pdf')
        .expect(201);

      expect(res.body).toEqual(
        expect.objectContaining({ uploaded: 1, discarded: 0, campaignId: LEGIT_ID }),
      );
      expect(fs.existsSync(join(getUploadsDir(LEGIT_ID), 'documento.pdf'))).toBe(true);
      expect(campaignsService.finalizeAttachments).toHaveBeenCalled();
    });
  });
});
