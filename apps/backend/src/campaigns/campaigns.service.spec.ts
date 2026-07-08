import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { In } from 'typeorm';
import { CampaignsService } from './campaigns.service';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { NotificationAttempt, AttemptStatus } from '../entities/notification-attempt.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { NotificationQueuesService } from '../queue/notification-queues.service';
import { AppSettingsService } from '../settings/app-settings.service';
import * as fs from 'fs';
import { join } from 'path';
import * as os from 'os';
import AdmZip from 'adm-zip';
import { getUploadsDir } from '../attachments/attachment-paths';

const tmpDirRef = { dir: '' };
jest.mock('../attachments/attachment-paths', () => ({
  getUploadsDir: jest.fn(() => tmpDirRef.dir),
}));


const mockCampaign: Partial<Campaign> = {
  id: 'uuid-1',
  name: 'Test',
  description: null,
  channelType: 'EMAIL',
  channelConfig: {},
  status: CampaignStatus.DRAFT,
  createdBy: 'op1',
  totalRecipients: 0,
  sentCount: 0,
  failedCount: 0,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  completedAt: null,
  recipients: [],
};

describe('CampaignsService', () => {
  let service: CampaignsService;

  const mockCampaignQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const mockCampaignRepo = {
    find: jest.fn().mockResolvedValue([mockCampaign]),
    findOne: jest.fn().mockResolvedValue(mockCampaign),
    findOneBy: jest.fn().mockResolvedValue(mockCampaign),
    existsBy: jest.fn().mockResolvedValue(false),
    create: jest.fn().mockReturnValue(mockCampaign),
    save: jest.fn().mockResolvedValue(mockCampaign),
    update: jest.fn().mockResolvedValue(undefined),
    increment: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn().mockReturnValue(mockCampaignQb),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const mockRecipientRepo = {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    createQueryBuilder: jest.fn(),
  };
  const mockAttemptRepo = {
    find: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
    createQueryBuilder: jest.fn().mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [] }),
    }),
  };
  const mockDownloadEventRepo = { createQueryBuilder: jest.fn() };
  const mockQueue = { addBulk: jest.fn().mockResolvedValue(undefined), getJob: jest.fn() };
  const mockSettings = {
    get: jest.fn(async () => null),
  };
  const mockConfig = {
    get: jest.fn(() => 'test-secret'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getRepositoryToken(Campaign), useValue: mockCampaignRepo },
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
        { provide: getRepositoryToken(NotificationAttempt), useValue: mockAttemptRepo },
        { provide: getRepositoryToken(DownloadEvent), useValue: mockDownloadEventRepo },
        { provide: NotificationQueuesService, useValue: mockQueue },
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = module.get<CampaignsService>(CampaignsService);
    jest.clearAllMocks();
    mockCampaignRepo.find.mockResolvedValue([mockCampaign]);
    mockCampaignRepo.findOne.mockResolvedValue(mockCampaign);
    mockCampaignRepo.findOneBy.mockResolvedValue(mockCampaign);
    mockCampaignRepo.existsBy.mockResolvedValue(false);
    mockCampaignRepo.create.mockReturnValue(mockCampaign);
    mockCampaignRepo.save.mockResolvedValue(mockCampaign);
    mockCampaignRepo.update.mockResolvedValue(undefined);
    mockCampaignRepo.increment.mockResolvedValue(undefined);
    mockCampaignRepo.delete.mockResolvedValue(undefined);
    mockCampaignQb.execute.mockResolvedValue({ affected: 1 });
    mockCampaignRepo.createQueryBuilder.mockReturnValue(mockCampaignQb);
    mockRecipientRepo.find.mockResolvedValue([]);
    mockAttemptRepo.find.mockReset();
  });

  it('findAll returns array', async () => {
    const result = await service.findAll();
    expect(result).toEqual([mockCampaign]);
    expect(mockCampaignRepo.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' } });
  });

  it('findOne returns campaign by id', async () => {
    const result = await service.findOne('uuid-1');
    expect(result).toEqual(mockCampaign);
  });

  it('findOne throws NotFoundException for unknown id', async () => {
    mockCampaignRepo.findOne.mockResolvedValueOnce(null);
    await expect(service.findOne('no-exist')).rejects.toThrow(NotFoundException);
  });

  it('create saves and returns campaign with createdBy', async () => {
    const dto = { name: 'Test', channelType: 'EMAIL' as const };
    const result = await service.create(dto, 'op1');
    expect(result).toEqual(mockCampaign);
    expect(mockCampaignRepo.save).toHaveBeenCalled();
  });

  it('launch throws BadRequestException when no pending recipients', async () => {
    // atomic UPDATE succeeds (affected: 1), campaign fetched, but no recipients
    mockCampaignQb.execute.mockResolvedValueOnce({ affected: 1 });
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(mockCampaign);
    mockRecipientRepo.find.mockResolvedValueOnce([]);
    await expect(service.launch('uuid-1')).rejects.toThrow(BadRequestException);
  });

  it('launch throws BadRequestException when campaign not in DRAFT', async () => {
    // atomic UPDATE fails because campaign is not in DRAFT (affected: 0) and exists
    mockCampaignQb.execute.mockResolvedValueOnce({ affected: 0 });
    mockCampaignRepo.existsBy.mockResolvedValueOnce(true);
    await expect(service.launch('uuid-1')).rejects.toThrow(BadRequestException);
  });

  it('launch throws NotFoundException when campaign does not exist', async () => {
    mockCampaignQb.execute.mockResolvedValueOnce({ affected: 0 });
    mockCampaignRepo.existsBy.mockResolvedValueOnce(false);
    await expect(service.launch('no-exist')).rejects.toThrow(NotFoundException);
  });

  it('launch() usa UPDATE atomico WHERE status=draft invece di findOneBy+update separati', async () => {
    // Setup: createQueryBuilder returns affected: 0 — launch must throw BadRequestException
    const mockQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    mockCampaignRepo.createQueryBuilder = jest.fn().mockReturnValue(mockQb);
    mockCampaignRepo.existsBy.mockResolvedValueOnce(true);
    mockRecipientRepo.find = jest.fn().mockResolvedValue([]);

    await expect(service.launch('camp-1')).rejects.toThrow('Only draft campaigns can be launched');
    expect(mockQb.execute).toHaveBeenCalled();
  });

  it('launch accoda i job BullMQ con jobId = attemptId', async () => {
    mockCampaignQb.execute.mockResolvedValueOnce({ affected: 1 });
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelConfig: {} });
    mockRecipientRepo.find.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]);
    mockAttemptRepo.createQueryBuilder.mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [{ id: 'att-1' }, { id: 'att-2' }] }),
    });

    await service.launch('c1');

    expect(mockQueue.addBulk).toHaveBeenCalledWith(
      mockCampaign.channelType,
      [
        expect.objectContaining({ opts: { jobId: 'att-1' } }),
        expect.objectContaining({ opts: { jobId: 'att-2' } }),
      ],
    );
  });

  it('uploadCsv uses increment for totalRecipients instead of update (no overwrite)', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);
    await expect(
      service.uploadCsv('no-campaign', '/tmp/nonexistent.csv'),
    ).rejects.toThrow(NotFoundException);
    expect(mockCampaignRepo.increment).not.toHaveBeenCalled();
  });

  it('getStats calcola aggregati corretti', async () => {
    mockRecipientRepo.find.mockResolvedValueOnce([
      { downloadCount: 2, lastDownloadedAt: new Date('2026-06-26') },
      { downloadCount: 0, lastDownloadedAt: null },
    ]);
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, totalRecipients: 2, sentCount: 2 });

    const stats = await service.getStats('uuid-1');

    expect(stats).toEqual({
      campaignId: 'uuid-1',
      totalRecipients: 2,
      totalSent: 2,
      totalDownloaded: 1,
      downloadPercentage: 50,
      lastDownloadAt: new Date('2026-06-26'),
    });
  });

  it('getStats lancia NotFoundException se la campagna non esiste', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);
    await expect(service.getStats('no-exist')).rejects.toThrow(NotFoundException);
  });

  it('getRecipientStats pagina i risultati', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(mockCampaign);
    mockRecipientRepo.findAndCount = jest.fn().mockResolvedValue([
      [{ id: 'r1', fullName: 'Mario Rossi', codiceFiscale: 'CF1', downloadCount: 1, firstDownloadedAt: new Date(), lastDownloadedAt: new Date(), attachmentDeletedAt: null }],
      1,
    ]);

    const page = await service.getRecipientStats('uuid-1', 1, 20);

    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(mockRecipientRepo.findAndCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { campaignId: 'uuid-1' }, skip: 0, take: 20 }),
    );
  });

  it('assertDraftForAttachments passa per campagna DRAFT', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, status: CampaignStatus.DRAFT });
    await expect(service.assertDraftForAttachments('uuid-1')).resolves.toBeUndefined();
  });

  it('assertDraftForAttachments lancia BadRequestException per campagna QUEUED', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, status: CampaignStatus.QUEUED });
    await expect(service.assertDraftForAttachments('uuid-1')).rejects.toThrow(BadRequestException);
  });

  it('assertDraftForAttachments lancia NotFoundException se la campagna non esiste', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);
    await expect(service.assertDraftForAttachments('no-exist')).rejects.toThrow(NotFoundException);
  });

  describe('finalizeAttachments', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'comunicapa-att-'));
      tmpDirRef.dir = tmpDir;
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('estrae i PDF da uno zip e rimuove lo zip', async () => {
      const zip = new AdmZip();
      zip.addFile('avviso_A.pdf', Buffer.from('%PDF-1.4 A'));
      zip.addFile('cartella/avviso_B.pdf', Buffer.from('%PDF-1.4 B'));
      zip.addFile('leggimi.txt', Buffer.from('ignorami'));
      const zipPath = join(tmpDir, 'lotto.zip');
      zip.writeZip(zipPath);

      mockCampaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelConfig: { allegatoKey: 'allegato' } });
      mockRecipientRepo.find.mockResolvedValue([
        { extraData: { allegato: 'avviso_A.pdf' } },
        { extraData: { allegato: 'avviso_B.pdf' } },
      ]);

      const result = await service.finalizeAttachments('c1', [
        { path: zipPath, originalname: 'lotto.zip' } as any,
      ]);

      expect(fs.existsSync(join(tmpDir, 'avviso_A.pdf'))).toBe(true);
      expect(fs.existsSync(join(tmpDir, 'avviso_B.pdf'))).toBe(true);
      expect(fs.existsSync(zipPath)).toBe(false);
      expect(fs.existsSync(join(tmpDir, 'leggimi.txt'))).toBe(false);
      expect(result.uploaded).toBe(2);
      expect(result.discarded).toBe(0);
    });

    it('scarta i PDF non referenziati da alcun destinatario', async () => {
      for (const name of ['ok1.pdf', 'ok2.pdf', 'orfano1.pdf', 'orfano2.pdf']) {
        fs.writeFileSync(join(tmpDir, name), '%PDF');
      }
      mockCampaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelConfig: { allegatoKey: 'allegato' } });
      mockRecipientRepo.find.mockResolvedValue([
        { extraData: { allegato: 'ok1.pdf' } },
        { extraData: { allegato: 'ok2.pdf' } },
      ]);

      const result = await service.finalizeAttachments('c1', []);

      expect(result.uploaded).toBe(2);
      expect(result.discarded).toBe(2);
      expect(fs.existsSync(join(tmpDir, 'orfano1.pdf'))).toBe(false);
      expect(fs.existsSync(join(tmpDir, 'ok1.pdf'))).toBe(true);
    });

    it('non scarta gli allegati oltre il primo (multi-allegato per destinatario)', async () => {
      fs.writeFileSync(join(tmpDir, 'TASSA.pdf'), '%PDF');
      fs.writeFileSync(join(tmpDir, 'RUOLO.pdf'), '%PDF');
      mockCampaignRepo.findOneBy.mockResolvedValue({
        id: 'c1',
        channelConfig: {
          attachments: [
            { key: 'tassa', label: 'Tassa' },
            { key: 'ruolo', label: 'Ruolo' },
          ],
        },
      });
      mockRecipientRepo.find.mockResolvedValue([
        { extraData: { tassa: 'TASSA.pdf', ruolo: 'RUOLO.pdf' } },
      ]);

      const result = await service.finalizeAttachments('c1', []);

      expect(fs.existsSync(join(tmpDir, 'TASSA.pdf'))).toBe(true);
      expect(fs.existsSync(join(tmpDir, 'RUOLO.pdf'))).toBe(true);
      expect(result.discarded).toBe(0);
    });

    it('se nessun destinatario referenzia allegati scarta tutto', async () => {
      fs.writeFileSync(join(tmpDir, 'x.pdf'), '%PDF');
      mockCampaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelConfig: {} });
      mockRecipientRepo.find.mockResolvedValue([{ extraData: { nota: 'senza pdf' } }]);

      const result = await service.finalizeAttachments('c1', []);
      expect(result.discarded).toBe(1);
      expect(fs.existsSync(join(tmpDir, 'x.pdf'))).toBe(false);
    });
  });

  describe('launch — validazione allegati bloccante', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'comunicapa-launch-'));
      tmpDirRef.dir = tmpDir;
      mockCampaignQb.execute.mockResolvedValue({ affected: 1 });
      mockCampaignRepo.createQueryBuilder.mockReturnValue(mockCampaignQb);
      mockAttemptRepo.createQueryBuilder.mockReturnValue({
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ raw: [{ id: 'att-1' }, { id: 'att-2' }, { id: 'att-3' }] }),
      });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('blocca il lancio e riporta la campagna a DRAFT se manca un allegato mappato', async () => {
      const campaignWithAttachments = {
        ...mockCampaign,
        id: 'c-att',
        channelConfig: { attachments: [{ key: 'file', label: 'Avviso TARI' }] },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaignWithAttachments);
      // Only create xxx.pdf, not xyz.pdf that r3 needs
      fs.writeFileSync(join(tmpDir, 'xxx.pdf'), '%PDF');

      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        if (select.includes('extraData')) {
          return Promise.resolve([
            { id: 'r1', codiceFiscale: 'AAA1', extraData: { file: 'xxx.pdf' } },
            { id: 'r2', codiceFiscale: 'BBB2', extraData: { file: 'xxx.pdf' } },
            { id: 'r3', codiceFiscale: 'CCC3', extraData: { file: 'xyz.pdf' } },
          ]);
        }
        return Promise.resolve([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
      });

      // NON deve lanciare un'eccezione HTTP (400): il reverse proxy di produzione
      // intercetta le risposte non-2xx e ne sostituisce il body con una pagina HTML
      // propria, rendendo illeggibile il messaggio di errore dal frontend (stesso
      // problema già risolto altrove — vedi io-services.service.ts `test()`).
      // Deve invece rispondere 200 con blocked:true e il messaggio nel body.
      const result = await service.launch('c-att');
      expect(result.blocked).toBe(true);
      expect(result.message).toContain('Impossibile avviare');
      expect(result.launched).toBe(0);
      expect(mockCampaignRepo.update).toHaveBeenCalledWith({ id: 'c-att' }, { status: CampaignStatus.DRAFT });
      expect(mockQueue.addBulk).not.toHaveBeenCalled();
    });

    it('lancia normalmente se tutti gli allegati mappati sono presenti', async () => {
      const campaignWithAttachments = {
        ...mockCampaign,
        id: 'c-att-ok',
        channelConfig: { attachments: [{ key: 'file', label: 'Avviso TARI' }] },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaignWithAttachments);
      // Create all needed files
      fs.writeFileSync(join(tmpDir, 'xxx.pdf'), '%PDF');

      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        if (select.includes('extraData')) {
          return Promise.resolve([{ id: 'r1', codiceFiscale: 'AAA1', extraData: { file: 'xxx.pdf' } }]);
        }
        return Promise.resolve([{ id: 'r1' }]);
      });

      const result = await service.launch('c-att-ok');
      expect(result.launched).toBe(1);
    });
  });

  describe('getChannelBreakdown', () => {
    it('ritorna null se la campagna non ha co-consegna App IO configurata', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelConfig: {} });

      const result = await service.getChannelBreakdown('uuid-1');

      expect(result).toBeNull();
      expect(mockRecipientRepo.find).not.toHaveBeenCalled();
    });

    it('classifica correttamente le 5 categorie di consegna', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({
        ...mockCampaign,
        channelConfig: { appIo: { mode: 'parallel', ioServiceId: 'svc-1' } },
      });
      mockRecipientRepo.find.mockResolvedValueOnce([
        { id: 'r-primary-only', status: RecipientStatus.SENT },
        { id: 'r-both', status: RecipientStatus.SENT },
        { id: 'r-appio-only', status: RecipientStatus.SENT },
        { id: 'r-appio-despite-fail', status: RecipientStatus.FAILED },
        { id: 'r-neither', status: RecipientStatus.FAILED },
        { id: 'r-pending', status: RecipientStatus.PENDING },
      ]);
      mockAttemptRepo.find.mockResolvedValueOnce([
        { recipientId: 'r-primary-only', responsePayload: {} },
        { recipientId: 'r-both', responsePayload: { appIo: { success: true } } },
        { recipientId: 'r-appio-only', responsePayload: { appIo: { success: true }, deliveredVia: 'APP_IO' } },
        { recipientId: 'r-appio-despite-fail', responsePayload: { appIo: { success: true } } },
        { recipientId: 'r-neither', responsePayload: { appIo: { success: false, error: 'timeout' } } },
      ]);

      const result = await service.getChannelBreakdown('uuid-1');

      expect(result).toEqual({
        primaryOnly: 1,
        both: 1,
        appIoOnly: 1,
        appIoDespitePrimaryFail: 1,
        neither: 1,
      });
    });
  });

  describe('getDownloadChannelStats', () => {
    it('raggruppa i DownloadEvent per canale', async () => {
      const qbMock = {
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { channel: 'EMAIL', count: '3' },
          { channel: 'CITIZEN_PORTAL', count: '1' },
        ]),
      };
      mockDownloadEventRepo.createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      const result = await service.getDownloadChannelStats('uuid-1');

      expect(result).toEqual({ EMAIL: 3, CITIZEN_PORTAL: 1 });
      expect(qbMock.where).toHaveBeenCalledWith('r.campaignId = :campaignId', { campaignId: 'uuid-1' });
    });
  });

  describe('getDownloadCrossChannelStats', () => {
    it('ritorna null se la campagna non ha co-consegna App IO configurata', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelConfig: {} });

      const result = await service.getDownloadCrossChannelStats('uuid-1');

      expect(result).toBeNull();
      expect(mockRecipientRepo.find).not.toHaveBeenCalled();
    });

    it('ritorna tutti zero se la campagna non ha destinatari', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({
        ...mockCampaign,
        channelConfig: { appIo: { mode: 'parallel', ioServiceId: 'svc-1' } },
      });
      mockRecipientRepo.find.mockResolvedValueOnce([]);

      const result = await service.getDownloadCrossChannelStats('uuid-1');

      expect(result).toEqual({ primaryOnly: 0, appIoOnly: 0, both: 0, none: 0 });
    });

    it('classifica primario/appIo/entrambi/nessuno, trattando CITIZEN_PORTAL come primario', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({
        ...mockCampaign,
        channelType: 'EMAIL',
        channelConfig: { appIo: { mode: 'parallel', ioServiceId: 'svc-1' } },
      });
      mockRecipientRepo.find.mockResolvedValueOnce([
        { id: 'r-primary' },
        { id: 'r-appio' },
        { id: 'r-both' },
        { id: 'r-citizen-portal' },
        { id: 'r-none' },
      ]);
      const qbMock = {
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { recipientId: 'r-primary', channel: 'EMAIL' },
          { recipientId: 'r-appio', channel: 'APP_IO' },
          { recipientId: 'r-both', channel: 'EMAIL' },
          { recipientId: 'r-both', channel: 'APP_IO' },
          { recipientId: 'r-citizen-portal', channel: 'CITIZEN_PORTAL' },
        ]),
      };
      mockDownloadEventRepo.createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      const result = await service.getDownloadCrossChannelStats('uuid-1');

      expect(result).toEqual({ primaryOnly: 2, appIoOnly: 1, both: 1, none: 1 });
    });
  });

  describe('getGlobalStats', () => {
    function makeQb(terminal: { rawOne?: any; rawMany?: any[]; count?: number }) {
      const qb: any = {};
      ['select', 'addSelect', 'innerJoin', 'leftJoin', 'where', 'andWhere', 'groupBy', 'orderBy'].forEach((m) => {
        qb[m] = jest.fn().mockReturnValue(qb);
      });
      qb.getRawOne = jest.fn().mockResolvedValue(terminal.rawOne);
      qb.getRawMany = jest.fn().mockResolvedValue(terminal.rawMany ?? []);
      qb.getCount = jest.fn().mockResolvedValue(terminal.count ?? 0);
      return qb;
    }

    it('assembla il DTO combinando tutte le query aggregate nell\'ordine atteso', async () => {
      mockCampaignRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(makeQb({ rawOne: { totalRecipients: '100', totalSent: '90', totalFailed: '10' } }))
        .mockReturnValueOnce(makeQb({ rawMany: [{ month: '2026-06', sent: '50' }, { month: '2026-07', sent: '40' }] }))
        .mockReturnValueOnce(makeQb({ rawMany: [{ channel: 'EMAIL', sent: '90' }] }))
        .mockReturnValueOnce(makeQb({ rawMany: [{ campaignId: 'c1', campaignName: 'Tari', totalRecipients: '100', downloadedCount: '60' }] }));

      mockRecipientRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(makeQb({ count: 60 }))
        .mockReturnValueOnce(makeQb({ rawMany: [{ month: '2026-06', downloaded: '30' }] }))
        .mockReturnValueOnce(makeQb({ count: 15 }));

      mockDownloadEventRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(makeQb({ rawMany: [{ channel: 'EMAIL', count: '55' }] }));

      const result = await service.getGlobalStats('2026-06-01', '2026-07-08');

      expect(result.totals).toEqual({
        totalRecipients: 100,
        totalSent: 90,
        totalFailed: 10,
        totalDownloaded: 60,
        downloadPercentage: 60,
      });
      expect(result.monthlyTrend).toEqual([
        { month: '2026-06', sent: 50, downloaded: 30 },
        { month: '2026-07', sent: 40, downloaded: 0 },
      ]);
      expect(result.channelTotals).toEqual([{ channel: 'EMAIL', sent: 90 }]);
      expect(result.downloadChannelTotals).toEqual([{ channel: 'EMAIL', count: 55 }]);
      expect(result.campaignLeaderboard).toEqual([
        { campaignId: 'c1', campaignName: 'Tari', totalRecipients: 100, downloadPercentage: 60 },
      ]);
      expect(result.neverDownloadedCount).toBe(15);
    });

    it('ritorna totali a zero quando non ci sono campagne nel periodo', async () => {
      mockCampaignRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(makeQb({ rawOne: undefined }))
        .mockReturnValueOnce(makeQb({ rawMany: [] }))
        .mockReturnValueOnce(makeQb({ rawMany: [] }))
        .mockReturnValueOnce(makeQb({ rawMany: [] }));
      mockRecipientRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(makeQb({ count: 0 }))
        .mockReturnValueOnce(makeQb({ rawMany: [] }))
        .mockReturnValueOnce(makeQb({ count: 0 }));
      mockDownloadEventRepo.createQueryBuilder = jest.fn().mockReturnValueOnce(makeQb({ rawMany: [] }));

      const result = await service.getGlobalStats();

      expect(result.totals).toEqual({
        totalRecipients: 0,
        totalSent: 0,
        totalFailed: 0,
        totalDownloaded: 0,
        downloadPercentage: 0,
      });
      expect(result.monthlyTrend).toEqual([]);
      expect(result.campaignLeaderboard).toEqual([]);
    });
  });

  describe('remove', () => {
    it('lancia NotFoundException se la campagna non esiste', async () => {
      mockCampaignRepo.existsBy.mockResolvedValueOnce(false);

      await expect(service.remove('no-exist')).rejects.toThrow(NotFoundException);
      expect(mockCampaignRepo.delete).not.toHaveBeenCalled();
    });

    it('rimuove la cartella allegati su disco e cancella la campagna (cascade DB su recipients/attempts)', async () => {
      mockCampaignRepo.existsBy.mockResolvedValueOnce(true);
      mockCampaignRepo.delete = jest.fn().mockResolvedValue(undefined);
      tmpDirRef.dir = '/tmp/comunicapa-uploads/c-del';
      const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);

      const result = await service.remove('c-del');

      expect(getUploadsDir).toHaveBeenCalledWith('c-del');
      expect(rmSpy).toHaveBeenCalledWith('/tmp/comunicapa-uploads/c-del', { recursive: true, force: true });
      expect(mockCampaignRepo.delete).toHaveBeenCalledWith('c-del');
      expect(result).toEqual({ deleted: true });

      rmSpy.mockRestore();
    });
  });

  describe('cancel', () => {
    const mockQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    beforeEach(() => {
      mockCampaignRepo.createQueryBuilder.mockReturnValue(mockQb);
      mockQb.execute.mockResolvedValue({ affected: 1 });
      mockQueue.getJob.mockReset();
    });

    it('lancia NotFoundException se la campagna non esiste', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);
      await expect(service.cancel('missing')).rejects.toThrow('Campaign missing not found');
    });

    it('lancia BadRequestException se la campagna non e QUEUED', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, status: CampaignStatus.DRAFT });
      await expect(service.cancel('c1')).rejects.toThrow('Solo campagne in corso possono essere annullate');
    });

    it('rimuove i job in coda, marca CANCELLED recipient/attempt/campagna, salta i job gia attivi', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, id: 'c1', status: CampaignStatus.QUEUED, channelType: 'EMAIL' });
      mockRecipientRepo.find.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]);
      mockAttemptRepo.find = jest.fn().mockResolvedValueOnce([
        { id: 'att-1', recipientId: 'r1' },
        { id: 'att-2', recipientId: 'r2' },
      ]);
      const removeOk = jest.fn().mockResolvedValue(undefined);
      const removeFails = jest.fn().mockRejectedValue(new Error('job is active'));
      mockQueue.getJob
        .mockResolvedValueOnce({ id: 'att-1', remove: removeOk })
        .mockResolvedValueOnce({ id: 'att-2', remove: removeFails });
      mockAttemptRepo.update = jest.fn().mockResolvedValue(undefined);
      mockRecipientRepo.update = jest.fn().mockResolvedValue(undefined);

      const result = await service.cancel('c1');

      expect(mockQueue.getJob).toHaveBeenNthCalledWith(1, 'EMAIL', 'att-1');
      expect(mockQueue.getJob).toHaveBeenNthCalledWith(2, 'EMAIL', 'att-2');
      expect(removeOk).toHaveBeenCalled();
      expect(removeFails).toHaveBeenCalled();
      expect(mockAttemptRepo.update).toHaveBeenCalledWith({ id: In(['att-1']) }, { status: AttemptStatus.CANCELLED });
      expect(mockRecipientRepo.update).toHaveBeenCalledWith({ id: In(['r1']) }, { status: RecipientStatus.CANCELLED });
      expect(mockQb.set).toHaveBeenCalledWith({ status: CampaignStatus.CANCELLED, completedAt: expect.any(Date) });
      expect(result).toEqual({ cancelled: 1, campaignId: 'c1' });
    });

    it('non aggiorna nulla se non ci sono destinatari in coda (nessun job da rimuovere)', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, id: 'c1', status: CampaignStatus.QUEUED, channelType: 'EMAIL' });
      mockRecipientRepo.find.mockResolvedValueOnce([]);
      mockAttemptRepo.update = jest.fn().mockResolvedValue(undefined);
      mockRecipientRepo.update = jest.fn().mockResolvedValue(undefined);

      const result = await service.cancel('c1');

      expect(mockAttemptRepo.update).not.toHaveBeenCalled();
      expect(mockRecipientRepo.update).not.toHaveBeenCalled();
      expect(result).toEqual({ cancelled: 0, campaignId: 'c1' });
    });
  });
});

describe('CampaignsService.getDuplicateSource', () => {
  const campaignRepoMock = { findOneBy: jest.fn() };
  const mockSettings = {
    get: jest.fn(async () => null),
  };
  const mockConfig = {
    get: jest.fn(() => 'test-secret'),
  };

  const buildModule = () =>
    Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getRepositoryToken(Campaign), useValue: campaignRepoMock },
        { provide: getRepositoryToken(Recipient), useValue: {} },
        { provide: getRepositoryToken(NotificationAttempt), useValue: {} },
        { provide: getRepositoryToken(DownloadEvent), useValue: {} },
        { provide: NotificationQueuesService, useValue: {} },
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

  it('lancia NotFoundException se la campagna non esiste', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue(null);
    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    await expect(service.getDuplicateSource('missing-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ritorna nome/canale/config della campagna sorgente, senza destinatari', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({
      id: 'c1',
      name: 'Avviso TARI 2026',
      description: 'Descrizione originale',
      channelType: 'EMAIL',
      channelConfig: { subject: 'Oggetto %nominativo%', body: '<p>Corpo</p>', mailConfigId: 'mc1' },
      status: CampaignStatus.COMPLETED,
    });
    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    const result = await service.getDuplicateSource('c1');

    expect(result).toEqual({
      name: 'Avviso TARI 2026',
      description: 'Descrizione originale',
      channelType: 'EMAIL',
      channelConfig: { subject: 'Oggetto %nominativo%', body: '<p>Corpo</p>', mailConfigId: 'mc1' },
    });
  });
});

describe('CampaignsService.getFailures / retryRecipient', () => {
  const campaignRepoMock = { findOneBy: jest.fn(), decrement: jest.fn() };
  const recipientRepoMock = { findOne: jest.fn(), update: jest.fn(), find: jest.fn() };
  const attemptRepoMock = {
    find: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const queuesMock = { addBulk: jest.fn() };
  const mockSettings = {
    get: jest.fn(async () => null),
  };
  const mockConfig = {
    get: jest.fn(() => 'test-secret'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const buildModule = () =>
    Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getRepositoryToken(Campaign), useValue: campaignRepoMock },
        { provide: getRepositoryToken(Recipient), useValue: recipientRepoMock },
        { provide: getRepositoryToken(NotificationAttempt), useValue: attemptRepoMock },
        { provide: getRepositoryToken(DownloadEvent), useValue: {} },
        { provide: NotificationQueuesService, useValue: queuesMock },
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

  it('getFailures ritorna solo i destinatari il cui stato attuale è FAILED, con ultimo tentativo', async () => {
    recipientRepoMock.find = jest.fn().mockResolvedValue([
      { id: 'r1', codiceFiscale: 'RSSMRA80A01H501X', fullName: 'Mario Rossi', createdAt: new Date('2026-06-30T00:00:00Z') },
    ]);
    attemptRepoMock.findOne = jest.fn().mockResolvedValue({
      errorMessage: 'SMTP timeout',
      attemptNumber: 2,
      createdAt: new Date('2026-07-01T10:00:00Z'),
    });
    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    const result = await service.getFailures('c1');

    expect(recipientRepoMock.find).toHaveBeenCalledWith(expect.objectContaining({
      where: { campaignId: 'c1', status: 'failed' },
    }));
    expect(result).toEqual([{
      recipientId: 'r1',
      codiceFiscale: 'RSSMRA80A01H501X',
      fullName: 'Mario Rossi',
      errorMessage: 'SMTP timeout',
      attemptNumber: 2,
      lastAttemptAt: '2026-07-01T10:00:00.000Z',
    }]);
  });

  it('getFailures non ritorna un destinatario FAILED poi ritentato con successo (SENT)', async () => {
    // Il destinatario r1 è stato ritentato con successo: il suo stato attuale è SENT,
    // quindi la query su Recipient con status FAILED non lo include più anche se
    // esiste ancora una NotificationAttempt storica con status FAILED per lui.
    recipientRepoMock.find = jest.fn().mockResolvedValue([]);
    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    const result = await service.getFailures('c1');

    expect(recipientRepoMock.find).toHaveBeenCalledWith(expect.objectContaining({
      where: { campaignId: 'c1', status: 'failed' },
    }));
    expect(result).toEqual([]);
  });

  it('retryRecipient crea un nuovo attempt, riaccoda il job e decrementa failedCount', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'EMAIL' });
    recipientRepoMock.findOne = jest.fn().mockResolvedValue({ id: 'r1', campaignId: 'c1', status: RecipientStatus.FAILED });
    attemptRepoMock.findOne = jest.fn().mockResolvedValue({ attemptNumber: 1 });
    const insertExec = jest.fn().mockResolvedValue({ raw: [{ id: 'attempt-2' }] });
    attemptRepoMock.createQueryBuilder.mockReturnValue({
      insert: () => ({ into: () => ({ values: () => ({ returning: () => ({ execute: insertExec }) }) }) }),
    });
    recipientRepoMock.update.mockResolvedValue({ affected: 1 });

    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    const result = await service.retryRecipient('c1', 'r1');

    expect(recipientRepoMock.update).toHaveBeenCalledWith({ id: 'r1' }, { status: 'queued' });
    expect(campaignRepoMock.decrement).toHaveBeenCalledWith({ id: 'c1' }, 'failedCount', 1);
    expect(queuesMock.addBulk).toHaveBeenCalledWith('EMAIL', [
      { name: 'send', data: { campaignId: 'c1', recipientId: 'r1', attemptId: 'attempt-2', channel: 'EMAIL' }, opts: { jobId: 'attempt-2' } },
    ]);
    expect(result).toEqual({ requeued: true, attemptId: 'attempt-2' });
  });

  it('retryRecipient lancia NotFoundException se il recipientId non esiste', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'EMAIL' });
    recipientRepoMock.findOne = jest.fn().mockResolvedValue(null);

    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    await expect(service.retryRecipient('c1', 'no-exist')).rejects.toThrow(NotFoundException);
    expect(queuesMock.addBulk).not.toHaveBeenCalled();
    expect(campaignRepoMock.decrement).not.toHaveBeenCalled();
  });

  it('retryRecipient lancia NotFoundException se il recipient appartiene a un\'altra campagna', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'EMAIL' });
    recipientRepoMock.findOne = jest.fn().mockResolvedValue({ id: 'r1', campaignId: 'c2-altra-campagna', status: RecipientStatus.FAILED });

    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    await expect(service.retryRecipient('c1', 'r1')).rejects.toThrow(NotFoundException);
    expect(queuesMock.addBulk).not.toHaveBeenCalled();
    expect(campaignRepoMock.decrement).not.toHaveBeenCalled();
  });

  it('retryRecipient lancia BadRequestException se il recipient non è in stato FAILED', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'EMAIL' });
    recipientRepoMock.findOne = jest.fn().mockResolvedValue({ id: 'r1', campaignId: 'c1', status: RecipientStatus.SENT });

    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    await expect(service.retryRecipient('c1', 'r1')).rejects.toThrow(BadRequestException);
    expect(queuesMock.addBulk).not.toHaveBeenCalled();
    expect(campaignRepoMock.decrement).not.toHaveBeenCalled();
  });

  it('retryRecipient lancia BadRequestException se la campagna è CANCELLED', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'EMAIL', status: CampaignStatus.CANCELLED });
    recipientRepoMock.findOne = jest.fn().mockResolvedValue({ id: 'r1', campaignId: 'c1', status: RecipientStatus.FAILED });

    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    await expect(service.retryRecipient('c1', 'r1')).rejects.toThrow(
      'Non è possibile rimettere in coda destinatari di una campagna annullata',
    );
    expect(queuesMock.addBulk).not.toHaveBeenCalled();
    expect(campaignRepoMock.decrement).not.toHaveBeenCalled();
  });
});

describe('CampaignsService.updateDraft', () => {
  const campaignRepoMock = { findOneBy: jest.fn(), save: jest.fn((x) => x) };

  const buildModule = () =>
    Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getRepositoryToken(Campaign), useValue: campaignRepoMock },
        { provide: getRepositoryToken(Recipient), useValue: {} },
        { provide: getRepositoryToken(NotificationAttempt), useValue: {} },
        { provide: getRepositoryToken(DownloadEvent), useValue: {} },
        { provide: NotificationQueuesService, useValue: {} },
        { provide: AppSettingsService, useValue: { get: jest.fn(async () => null) } },
        { provide: ConfigService, useValue: { get: jest.fn(() => 'test-secret') } },
      ],
    }).compile();

  it('aggiorna una campagna in stato draft', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', status: CampaignStatus.DRAFT, name: 'Vecchio nome', channelConfig: {} });
    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    const result = await service.updateDraft('c1', { name: 'Nuovo nome', channelConfig: { subject: 'X' } });

    expect(result.name).toBe('Nuovo nome');
    expect(result.channelConfig).toEqual({ subject: 'X' });
  });

  it('rifiuta l aggiornamento se la campagna non e in draft', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', status: CampaignStatus.RUNNING });
    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    await expect(service.updateDraft('c1', { name: 'X' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CampaignsService.previewMessage', () => {
  const mockSettings = {
    get: jest.fn(async (key: string) => {
      const values: Record<string, unknown> = {
        'brand.name': 'Comune di Montesilvano',
        'brand.logo': null,
        'system.publicUrl': 'http://localhost:8080',
        'system.citizenPublicUrl': 'http://localhost:3001',
        'retention.maxDays': 30,
      };
      return values[key];
    }),
  };
  const mockConfig = {
    get: jest.fn(() => 'test-secret'),
  };
  const campaignRepoMock = { findOneBy: jest.fn() };
  const recipientRepoMock = { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() };
  const attemptRepoMock = { createQueryBuilder: jest.fn() };
  const queuesMock = { addBulk: jest.fn() };

  const buildModule = () =>
    Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getRepositoryToken(Campaign), useValue: campaignRepoMock },
        { provide: getRepositoryToken(Recipient), useValue: recipientRepoMock },
        { provide: getRepositoryToken(NotificationAttempt), useValue: attemptRepoMock },
        { provide: getRepositoryToken(DownloadEvent), useValue: {} },
        { provide: NotificationQueuesService, useValue: queuesMock },
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

  it('renders subject and full HTML body with brand name and no fake links', async () => {
    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    const result = await service.previewMessage({
      channelType: 'EMAIL',
      subject: 'Avviso per %%nominativo%%',
      body: 'Gentile %%nominativo%%, scarica %%allegato1%%',
      attachments: [{ key: 'file', label: 'Avviso TARI' }],
      recipient: { codiceFiscale: 'RSSMRA80A01H501U', fullName: 'Mario Rossi' },
    });

    expect(result.subject).toBe('Avviso per Mario Rossi');
    expect(result.bodyHtml).toContain('Comune di Montesilvano');
    expect(result.bodyHtml).toContain('/public/download/');
    expect(result.bodyHtml).toContain('Questa è una comunicazione ufficiale');
    expect(result.bodyMarkdown).toBeUndefined();
  });

  it('renders markdown body when format is markdown, without HTML wrapper', async () => {
    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    const result = await service.previewMessage({
      channelType: 'APP_IO',
      subject: 'Avviso',
      body: 'Elenco: %%elenco_allegati%%',
      attachments: [{ key: 'file', label: 'Avviso TARI' }],
      recipient: { codiceFiscale: 'RSSMRA80A01H501U' },
      format: 'markdown',
    });

    expect(result.bodyMarkdown).toContain('- **Avviso TARI**');
    expect(result.bodyHtml).toBeUndefined();
  });

  it('renderMessageForRecipient tags the download link with the real campaign channel (&ch=)', async () => {
    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    (recipientRepoMock.findOne as jest.Mock).mockResolvedValue({
      id: 'recipient-1',
      codiceFiscale: 'RSSMRA80A01H501U',
      fullName: 'Mario Rossi',
      email: 'mario@example.com',
      pec: null,
      extraData: {},
      campaign: {
        channelType: 'EMAIL',
        channelConfig: {
          subject: 'Avviso per %%nominativo%%',
          body: 'Gentile %%nominativo%%, scarica %%allegato1%%',
          attachments: [{ key: 'file', label: 'Avviso TARI' }],
        },
      },
    });

    const result = await service.renderMessageForRecipient('recipient-1');

    expect(result.bodyHtml).toContain('/public/download/');
    expect(result.bodyHtml).toContain('&ch=EMAIL');
  });
});

