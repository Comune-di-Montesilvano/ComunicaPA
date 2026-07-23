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
import { InadService } from '../channels/inad/inad.service';
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
    create: jest.fn(),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
    createQueryBuilder: jest.fn(),
  };
  const mockAttemptRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
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
    get: jest.fn(async (_key?: string): Promise<any> => null),
  };
  const mockConfig = {
    get: jest.fn(() => 'test-secret'),
  };
  const mockInadService = {
    extractDigitalAddress: jest.fn(),
    startBulkExtraction: jest.fn(),
    getBulkState: jest.fn(),
    getBulkResult: jest.fn(),
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
        { provide: InadService, useValue: mockInadService },
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
    mockInadService.getBulkState.mockReset();
    mockInadService.getBulkState.mockResolvedValue('DISPONIBILE');
  });

  it('findAll returns array', async () => {
    const result = await service.findAll();
    expect(result).toEqual([mockCampaign]);
    expect(mockCampaignRepo.find).toHaveBeenCalledWith({ order: { createdAt: 'DESC' } });
  });

  it('findOne returns campaign by id', async () => {
    const result = await service.findOne('uuid-1');
    expect(result).toEqual(mockCampaign);
    expect(mockCampaignRepo.findOneBy).toHaveBeenCalledWith({ id: 'uuid-1' });
  });

  it('findOne throws NotFoundException for unknown id', async () => {
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);
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

  it('launch NON accoda job sui motori canale per campagne SEND, ma accoda PROTOCOLLAZIONE (demoni pollano lo stato QUEUED)', async () => {
    mockCampaignQb.execute.mockResolvedValueOnce({ affected: 1 });
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelType: 'SEND', channelConfig: { protocolla: true, attachments: [{ key: 'doc', label: 'Documento' }] } });
    mockRecipientRepo.find.mockResolvedValue([{ id: 'r1' }]);
    mockAttemptRepo.createQueryBuilder.mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [{ id: 'att-1' }] }),
    });

    const result = await service.launch('c1');

    expect(mockQueue.addBulk).toHaveBeenCalledTimes(1);
    expect(mockQueue.addBulk).toHaveBeenCalledWith(
      'PROTOCOLLAZIONE',
      [expect.objectContaining({ opts: { jobId: 'att-1' } })],
    );
    expect(result).toEqual({ launched: 1, campaignId: 'c1' });
  });

  it('launch accoda un job PROTOCOLLAZIONE per attempt con jobId=attemptId per campagne SEND', async () => {
    mockCampaignQb.execute.mockResolvedValueOnce({ affected: 1 });
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelType: 'SEND', channelConfig: { protocolla: true, attachments: [{ key: 'doc', label: 'Documento' }] } });
    mockRecipientRepo.find.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
    mockAttemptRepo.createQueryBuilder.mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [{ id: 'att-1' }, { id: 'att-2' }] }),
    });

    await service.launch('c1');

    expect(mockQueue.addBulk).toHaveBeenCalledWith(
      'PROTOCOLLAZIONE',
      [
        expect.objectContaining({ opts: { jobId: 'att-1' } }),
        expect.objectContaining({ opts: { jobId: 'att-2' } }),
      ],
    );
  });

  it('launch rifiuta campagne SEND senza channelConfig.protocolla=true (fail fast, niente insert attempt)', async () => {
    mockCampaignQb.execute.mockResolvedValueOnce({ affected: 1 });
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelType: 'SEND', channelConfig: {} });

    await expect(service.launch('c-no-protocolla')).rejects.toThrow(BadRequestException);
    expect(mockAttemptRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(mockCampaignRepo.update).toHaveBeenCalledWith({ id: 'c-no-protocolla' }, { status: CampaignStatus.DRAFT });
  });

  it('launch rifiuta campagne SEND con channelConfig.protocolla=false', async () => {
    mockCampaignQb.execute.mockResolvedValueOnce({ affected: 1 });
    mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelType: 'SEND', channelConfig: { protocolla: false } });

    await expect(service.launch('c-protocolla-false')).rejects.toThrow(BadRequestException);
    expect(mockAttemptRepo.createQueryBuilder).not.toHaveBeenCalled();
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

  it('getRecipientStats pagina i risultati e seleziona i nuovi campi', async () => {
    const qb: any = {};
    ['select', 'where', 'andWhere', 'orderBy', 'skip', 'take'].forEach((m) => {
      qb[m] = jest.fn().mockReturnValue(qb);
    });
    qb.getManyAndCount = jest.fn().mockResolvedValue([
      [{ id: 'r1', fullName: 'Mario Rossi', codiceFiscale: 'AAA1', email: null, pec: null, status: 'sent', downloadCount: 0, firstDownloadedAt: null, lastDownloadedAt: null, attachmentDeletedAt: null }],
      1,
    ]);
    mockRecipientRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

    const page = await service.getRecipientStats('uuid-1', 1, 20);

    expect(mockRecipientRepo.createQueryBuilder).toHaveBeenCalledWith('r');
    expect(qb.where).toHaveBeenCalledWith('r.campaignId = :campaignId', { campaignId: 'uuid-1' });
    expect(qb.andWhere).not.toHaveBeenCalled();
    expect(qb.skip).toHaveBeenCalledWith(0);
    expect(qb.take).toHaveBeenCalledWith(20);
    expect(page).toEqual({ campaignId: 'uuid-1', page: 1, pageSize: 20, total: 1, items: expect.any(Array) });
  });

  it('getRecipientStats applica il filtro search su fullName o codiceFiscale', async () => {
    const qb: any = {};
    ['select', 'where', 'andWhere', 'orderBy', 'skip', 'take'].forEach((m) => {
      qb[m] = jest.fn().mockReturnValue(qb);
    });
    qb.getManyAndCount = jest.fn().mockResolvedValue([[], 0]);
    mockRecipientRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

    await service.getRecipientStats('uuid-1', 1, 20, 'rossi');

    expect(qb.andWhere).toHaveBeenCalledWith(
      '(r.fullName ILIKE :search OR r.codiceFiscale ILIKE :search)',
      { search: '%rossi%' },
    );
  });

  describe('CampaignsService.getRecipientStats — colonne SEND', () => {
    it('include iun/protocollo/stato SEND per l\'ultimo attempt di ciascun destinatario', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ id: 'camp-1', channelType: 'SEND' });
      const mockQb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([
          [{ id: 'r1', fullName: 'Mario Rossi', codiceFiscale: 'RSSMRA85M01H501Z', email: null, pec: null, status: 'sent', downloadCount: 0, firstDownloadedAt: null, lastDownloadedAt: null, attachmentDeletedAt: null }],
          1,
        ]),
      };
      mockRecipientRepo.createQueryBuilder.mockReturnValue(mockQb);
      mockAttemptRepo.find.mockResolvedValueOnce([
        { recipientId: 'r1', attemptNumber: 1, iun: null, sendStatus: null, sendStatusUpdatedAt: null, protocolNumber: 55, protocolYear: 2026 },
        { recipientId: 'r1', attemptNumber: 2, iun: 'ABCD-1234', sendStatus: 'ACCEPTED', sendStatusUpdatedAt: new Date('2026-07-11T08:00:00Z'), protocolNumber: 56, protocolYear: 2026 },
      ]);

      const result = await service.getRecipientStats('camp-1', 1, 50);

      expect(result.items[0]).toMatchObject({
        id: 'r1',
        iun: 'ABCD-1234',
        sendStatus: 'ACCEPTED',
        protocolNumber: 56,
        protocolYear: 2026,
      });
    });

    it('non aggiunge campi SEND per campagne di altri canali', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ id: 'camp-2', channelType: 'EMAIL' });
      const mockQb = {
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getManyAndCount: jest.fn().mockResolvedValue([
          [{ id: 'r2', fullName: 'Luigi Bianchi', codiceFiscale: 'BNCLGU80A01H501Y', email: 'l@b.it', pec: null, status: 'sent', downloadCount: 1, firstDownloadedAt: null, lastDownloadedAt: null, attachmentDeletedAt: null }],
          1,
        ]),
      };
      mockRecipientRepo.createQueryBuilder.mockReturnValue(mockQb);

      const result = await service.getRecipientStats('camp-2', 1, 50);

      expect(mockAttemptRepo.find).not.toHaveBeenCalled();
      expect(result.items[0].iun).toBeUndefined();
    });
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

    it('ridenomina i file per farli coincidere con il case-sensitivity referenziato nel CSV', async () => {
      fs.writeFileSync(join(tmpDir, 'ok_file.PDF'), '%PDF');
      mockCampaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelConfig: { allegatoKey: 'allegato' } });
      mockRecipientRepo.find.mockResolvedValue([
        { extraData: { allegato: 'ok_file.pdf' } },
      ]);

      const result = await service.finalizeAttachments('c1', []);

      expect(result.uploaded).toBe(1);
      expect(result.discarded).toBe(0);
      const files = fs.readdirSync(tmpDir);
      expect(files.includes('ok_file.PDF')).toBe(false);
      expect(files.includes('ok_file.pdf')).toBe(true);
    });

    it('non cancella e non scarta il file draft_recipients.csv', async () => {
      fs.writeFileSync(join(tmpDir, 'draft_recipients.csv'), 'headers,data');
      fs.writeFileSync(join(tmpDir, 'ok_file.pdf'), '%PDF');
      mockCampaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelConfig: { allegatoKey: 'allegato' } });
      mockRecipientRepo.find.mockResolvedValue([
        { extraData: { allegato: 'ok_file.pdf' } },
      ]);

      const result = await service.finalizeAttachments('c1', []);

      expect(result.uploaded).toBe(1);
      expect(result.discarded).toBe(0);
      const files = fs.readdirSync(tmpDir);
      expect(files.includes('draft_recipients.csv')).toBe(true);
      expect(files.includes('ok_file.pdf')).toBe(true);
    });
  });

  describe('resolveAttachmentPreviewFilePath', () => {
    // getUploadsDir è mockato globalmente in cima a questo file (vedi
    // `jest.mock('../attachments/attachment-paths', ...)`) per restituire
    // sempre `tmpDirRef.dir`, ignorando il campaignId passato — pattern
    // già usato da `finalizeAttachments` più sopra. Non serve quindi (e
    // non avrebbe effetto) impostare `process.env['ATTACHMENTS_PATH']`.
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'preview-file-'));
      tmpDirRef.dir = tmpDir;
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('risolve il path se il file esiste nella cartella upload della campagna', async () => {
      fs.writeFileSync(join(tmpDir, 'avviso.pdf'), '%PDF-1.4 test');
      mockCampaignRepo.existsBy.mockResolvedValue(true);

      const result = await service.resolveAttachmentPreviewFilePath('campaign-1', 'avviso.pdf');

      expect(result.path).toBe(join(tmpDir, 'avviso.pdf'));
      expect(result.contentType).toBe('application/pdf');
    });

    it('lancia NotFoundException se il filename non è tra i file presenti (whitelist)', async () => {
      fs.writeFileSync(join(tmpDir, 'reale.pdf'), '%PDF-1.4 test');
      mockCampaignRepo.existsBy.mockResolvedValue(true);

      await expect(service.resolveAttachmentPreviewFilePath('campaign-2', '../../../etc/passwd'))
        .rejects.toThrow(NotFoundException);
      await expect(service.resolveAttachmentPreviewFilePath('campaign-2', 'non-esiste.pdf'))
        .rejects.toThrow(NotFoundException);
    });

    it('lancia NotFoundException se la campagna non esiste', async () => {
      mockCampaignRepo.existsBy.mockResolvedValue(false);
      await expect(service.resolveAttachmentPreviewFilePath('inesistente', 'x.pdf'))
        .rejects.toThrow(NotFoundException);
    });

    it('usa Content-Type octet-stream per estensioni non-pdf', async () => {
      fs.writeFileSync(join(tmpDir, 'dati.zip'), 'PK...');
      mockCampaignRepo.existsBy.mockResolvedValue(true);

      const result = await service.resolveAttachmentPreviewFilePath('campaign-3', 'dati.zip');
      expect(result.contentType).toBe('application/octet-stream');
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
        channelConfig: { attachments: [{ key: 'file', label: 'Avviso TARI' }], body: '%%elenco_allegati%%' },
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

    it('blocca EMAIL con allegati se il template non contiene alcun placeholder allegato', async () => {
      const campaign = {
        ...mockCampaign,
        id: 'c-no-placeholder',
        channelType: 'EMAIL',
        channelConfig: {
          attachments: [{ key: 'file', label: 'Avviso TARI' }],
          body: 'Gentile %%nominativo%%, saluti.',
        },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaign);
      fs.writeFileSync(join(tmpDir, 'xxx.pdf'), '%PDF');
      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        if (select.includes('extraData')) {
          return Promise.resolve([{ id: 'r1', codiceFiscale: 'AAA1', extraData: { file: 'xxx.pdf' } }]);
        }
        return Promise.resolve([{ id: 'r1' }]);
      });

      const result = await service.launch('c-no-placeholder');
      expect(result.blocked).toBe(true);
      expect(result.message).toContain('elenco_allegati');
      expect(result.launched).toBe(0);
      expect(mockCampaignRepo.update).toHaveBeenCalledWith({ id: 'c-no-placeholder' }, { status: CampaignStatus.DRAFT });
      expect(mockQueue.addBulk).not.toHaveBeenCalled();
    });

    it('lancia EMAIL con allegati se il template contiene %%elenco_allegati%%', async () => {
      const campaign = {
        ...mockCampaign,
        id: 'c-elenco-ok',
        channelType: 'EMAIL',
        channelConfig: {
          attachments: [{ key: 'file', label: 'Avviso TARI' }],
          body: 'Gentile %%nominativo%%, vedi %%elenco_allegati%%.',
        },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaign);
      fs.writeFileSync(join(tmpDir, 'xxx.pdf'), '%PDF');
      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        if (select.includes('extraData')) {
          return Promise.resolve([{ id: 'r1', codiceFiscale: 'AAA1', extraData: { file: 'xxx.pdf' } }]);
        }
        return Promise.resolve([{ id: 'r1' }]);
      });

      const result = await service.launch('c-elenco-ok');
      expect(result.launched).toBe(1);
    });

    it('blocca EMAIL con 2 allegati se manca il link singolo per uno dei due', async () => {
      const campaign = {
        ...mockCampaign,
        id: 'c-parziale',
        channelType: 'EMAIL',
        channelConfig: {
          attachments: [{ key: 'file1', label: 'Avviso' }, { key: 'file2', label: 'Ruolo' }],
          body: 'Documenti: %%allegato1%%',
        },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaign);
      fs.writeFileSync(join(tmpDir, 'xxx.pdf'), '%PDF');
      fs.writeFileSync(join(tmpDir, 'yyy.pdf'), '%PDF');
      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        if (select.includes('extraData')) {
          return Promise.resolve([{ id: 'r1', codiceFiscale: 'AAA1', extraData: { file1: 'xxx.pdf', file2: 'yyy.pdf' } }]);
        }
        return Promise.resolve([{ id: 'r1' }]);
      });

      const result = await service.launch('c-parziale');
      expect(result.blocked).toBe(true);
      expect(result.launched).toBe(0);
    });

    it('NON blocca POSTAL con allegati e body senza placeholder (corpo non è contenuto reale)', async () => {
      const campaign = {
        ...mockCampaign,
        id: 'c-postal',
        channelType: 'POSTAL',
        channelConfig: {
          attachments: [{ key: 'file', label: 'Lettera' }],
          body: '',
        },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaign);
      fs.writeFileSync(join(tmpDir, 'xxx.pdf'), '%PDF');
      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        if (select.includes('extraData')) {
          return Promise.resolve([{ id: 'r1', codiceFiscale: 'AAA1', extraData: { file: 'xxx.pdf' } }]);
        }
        return Promise.resolve([{ id: 'r1' }]);
      });

      const result = await service.launch('c-postal');
      expect(result.blocked).toBeUndefined();
      expect(result.launched).toBe(1);
    });

    it('blocca la co-consegna App IO differenziata se bodyOverride non ha placeholder, anche se il corpo primario è ok', async () => {
      const campaign = {
        ...mockCampaign,
        id: 'c-appio-override',
        channelType: 'EMAIL',
        channelConfig: {
          attachments: [{ key: 'file', label: 'Avviso TARI' }],
          body: 'Corpo primario con %%elenco_allegati%%.',
          secondaryChannels: [
            { channel: 'APP_IO', mode: 'parallel', bodyOverride: 'Testo App IO senza placeholder allegati.' },
          ],
        },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaign);
      fs.writeFileSync(join(tmpDir, 'xxx.pdf'), '%PDF');
      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        if (select.includes('extraData')) {
          return Promise.resolve([{ id: 'r1', codiceFiscale: 'AAA1', extraData: { file: 'xxx.pdf' } }]);
        }
        return Promise.resolve([{ id: 'r1' }]);
      });

      const result = await service.launch('c-appio-override');
      expect(result.blocked).toBe(true);
      expect(result.message).toContain('App IO');
      expect(result.launched).toBe(0);
    });
  });

  describe('launch — check INAD extract-loop (sotto soglia)', () => {
    beforeEach(() => {
      mockCampaignQb.execute.mockResolvedValue({ affected: 1 });
      mockCampaignRepo.createQueryBuilder.mockReturnValue(mockCampaignQb);
      mockAttemptRepo.createQueryBuilder.mockReturnValue({
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ raw: [{ id: 'att-1' }, { id: 'att-2' }] }),
      });
      mockInadService.extractDigitalAddress.mockReset();
      mockInadService.startBulkExtraction.mockReset();
    });

    it('override verso PEC un destinatario EMAIL con domicilio INAD trovato, sotto soglia', async () => {
      mockSettings.get.mockImplementation(async (key?: string) => (key === 'inad.checkEnabled' ? true : null));
      const campaignEmail = { ...mockCampaign, id: 'c-inad-1', channelType: 'EMAIL', channelConfig: {} };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaignEmail);
      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        if (select?.includes('extraData')) return Promise.resolve([]);
        return Promise.resolve([
          { id: 'r1', codiceFiscale: 'CF1', pec: null },
          { id: 'r2', codiceFiscale: 'CF2', pec: null },
        ]);
      });
      mockInadService.extractDigitalAddress.mockImplementation(async (cf: string) => {
        if (cf === 'CF1') return { found: true, data: { codiceFiscale: 'CF1', since: '2026-01-01', digitalAddress: [{ digitalAddress: 'trovato@pec.it', usageInfo: { motivation: 'CESSAZIONE_VOLONTARIA', dateEndValidity: '2020-01-01' } }] } };
        return { found: false };
      });

      const result = await service.launch('c-inad-1');

      expect(result.launched).toBe(2);
      expect(mockInadService.extractDigitalAddress).toHaveBeenCalledWith('CF1');
      expect(mockInadService.extractDigitalAddress).toHaveBeenCalledWith('CF2');
      expect(mockRecipientRepo.update).toHaveBeenCalledWith(
        { id: 'r1' },
        expect.objectContaining({ pec: 'trovato@pec.it', inadCheck: expect.objectContaining({ found: true }) }),
      );
      expect(mockRecipientRepo.update).toHaveBeenCalledWith(
        { id: 'r2' },
        expect.objectContaining({ inadCheck: expect.objectContaining({ found: false }) }),
      );
      expect(mockInadService.startBulkExtraction).not.toHaveBeenCalled();
    });

    it('non fa alcun check INAD se il toggle è disattivato', async () => {
      mockSettings.get.mockImplementation(async () => false);
      const campaignEmail = { ...mockCampaign, id: 'c-inad-2', channelType: 'EMAIL', channelConfig: {} };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaignEmail);
      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        if (select?.includes('extraData')) return Promise.resolve([]);
        return Promise.resolve([{ id: 'r1' }]);
      });

      await service.launch('c-inad-2');

      expect(mockInadService.extractDigitalAddress).not.toHaveBeenCalled();
    });

    it('non fa alcun check INAD per campagne SEND anche col toggle attivo', async () => {
      const tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'comunicapa-launch-inad-'));
      tmpDirRef.dir = tmpDir;
      try {
        fs.writeFileSync(join(tmpDir, 'x.pdf'), '%PDF');
        mockSettings.get.mockImplementation(async (key?: string) => (key === 'inad.checkEnabled' ? true : (key === 'send.environment' ? undefined : null)));
        const campaignSend = { ...mockCampaign, id: 'c-inad-3', channelType: 'SEND', channelConfig: { protocolla: true, attachments: [{ key: 'a', label: 'A' }] } };
        mockCampaignRepo.findOneBy.mockResolvedValue(campaignSend);
        mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
          if (select?.includes('extraData')) return Promise.resolve([{ id: 'r1', codiceFiscale: 'CF1', extraData: { a: 'x.pdf' } }]);
          return Promise.resolve([{ id: 'r1' }]);
        });

        await service.launch('c-inad-3');

        expect(mockInadService.extractDigitalAddress).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('launch — check INAD bulk (sopra soglia)', () => {
    beforeEach(() => {
      mockCampaignQb.execute.mockResolvedValue({ affected: 1 });
      mockCampaignRepo.createQueryBuilder.mockReturnValue(mockCampaignQb);
      mockInadService.startBulkExtraction.mockReset();
      mockInadService.getBulkResult.mockReset();
    });

    it('avvia il bulk e porta la campagna a CHECKING_INAD senza creare attempt', async () => {
      mockSettings.get.mockImplementation(async (key?: string) => (key === 'inad.checkEnabled' ? true : null));
      const campaignEmail = { ...mockCampaign, id: 'c-bulk-1', channelType: 'EMAIL', channelConfig: {} };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaignEmail);
      const manyRecipients = Array.from({ length: 150 }, (_, i) => ({ id: `r${i}`, codiceFiscale: `CF${i}` }));
      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        if (select?.includes('extraData')) return Promise.resolve([]);
        return Promise.resolve(manyRecipients);
      });
      mockInadService.startBulkExtraction.mockResolvedValue({ id: 'batch-1' });

      const result = await service.launch('c-bulk-1');

      expect(result.launched).toBe(0);
      expect(mockInadService.startBulkExtraction).toHaveBeenCalledTimes(1);
      const [cfList] = mockInadService.startBulkExtraction.mock.calls[0];
      expect(cfList).toHaveLength(150);
      expect(mockCampaignRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: CampaignStatus.CHECKING_INAD }),
      );
      expect(mockAttemptRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('finalizeInadCheck applica i risultati e lancia createAttemptsAndEnqueue', async () => {
      const campaignChecking = {
        ...mockCampaign,
        id: 'c-bulk-2',
        channelType: 'EMAIL',
        status: CampaignStatus.CHECKING_INAD,
        channelConfig: {
          inadCheck: {
            mechanism: 'bulk',
            batches: [{ id: 'batch-2', recipientIds: ['r1', 'r2'], done: false }],
            requestedAt: '2026-01-01T00:00:00Z',
          },
        },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaignChecking);
      mockRecipientRepo.find.mockResolvedValue([
        { id: 'r1', codiceFiscale: 'CF1', pec: null, email: 'e1@x.it' },
        { id: 'r2', codiceFiscale: 'CF2', pec: null, email: 'e2@x.it' },
      ]);
      mockInadService.getBulkResult.mockResolvedValue([
        { codiceFiscale: 'CF1', since: '2026-01-01', digitalAddress: [{ digitalAddress: 'trovato@pec.it' }] },
        { codiceFiscale: 'CF2', since: '2026-01-01' },
      ]);
      mockAttemptRepo.createQueryBuilder.mockReturnValue({
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ raw: [{ id: 'att-1' }, { id: 'att-2' }] }),
      });

      await service.finalizeInadCheck('c-bulk-2');

      expect(mockInadService.getBulkResult).toHaveBeenCalledWith('batch-2');
      expect(mockRecipientRepo.update).toHaveBeenCalledWith(
        { id: 'r1' },
        expect.objectContaining({ pec: 'trovato@pec.it' }),
      );
      expect(mockCampaignQb.set).toHaveBeenCalledWith({ status: CampaignStatus.QUEUED });
      expect(mockCampaignQb.where).toHaveBeenCalledWith('id = :id AND status = :checking', {
        id: 'c-bulk-2',
        checking: CampaignStatus.CHECKING_INAD,
      });
      expect(mockAttemptRepo.createQueryBuilder).toHaveBeenCalled();
    });

    it('finalizeInadCheck non ricrea gli attempt se un altro invocatore ha già vinto la transizione a QUEUED (race)', async () => {
      const campaignChecking = {
        ...mockCampaign,
        id: 'c-bulk-race',
        channelType: 'EMAIL',
        status: CampaignStatus.CHECKING_INAD,
        channelConfig: {
          inadCheck: {
            mechanism: 'bulk',
            batches: [{ id: 'batch-race', recipientIds: ['r1', 'r2'], done: false }],
            requestedAt: '2026-01-01T00:00:00Z',
          },
        },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaignChecking);
      mockRecipientRepo.find.mockResolvedValue([
        { id: 'r1', codiceFiscale: 'CF1', pec: null, email: 'e1@x.it' },
        { id: 'r2', codiceFiscale: 'CF2', pec: null, email: 'e2@x.it' },
      ]);
      mockInadService.getBulkResult.mockResolvedValue([
        { codiceFiscale: 'CF1', since: '2026-01-01', digitalAddress: [{ digitalAddress: 'trovato@pec.it' }] },
        { codiceFiscale: 'CF2', since: '2026-01-01' },
      ]);
      // Simula un'altra invocazione concorrente che ha già vinto la
      // transizione CHECKING_INAD -> QUEUED su questo campaignId.
      mockCampaignQb.execute.mockResolvedValueOnce({ affected: 0 });

      await service.finalizeInadCheck('c-bulk-race');

      expect(mockCampaignQb.set).toHaveBeenCalledWith({ status: CampaignStatus.QUEUED });
      expect(mockAttemptRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(mockQueue.addBulk).not.toHaveBeenCalled();
    });

    it('nessun destinatario con CF (bulk path, tutti privi): salta CHECKING_INAD e lancia direttamente', async () => {
      mockSettings.get.mockImplementation(async (key?: string) => (key === 'inad.checkEnabled' ? true : null));
      const campaignEmail = { ...mockCampaign, id: 'c-bulk-nocf', channelType: 'EMAIL', channelConfig: {} };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaignEmail);
      const manyRecipientsNoCf = Array.from({ length: 150 }, (_, i) => ({ id: `r${i}`, codiceFiscale: null }));
      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        if (select?.includes('extraData')) return Promise.resolve([]);
        return Promise.resolve(manyRecipientsNoCf);
      });
      mockAttemptRepo.createQueryBuilder.mockReturnValue({
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ raw: manyRecipientsNoCf.map((r) => ({ id: `att-${r.id}` })) }),
      });

      const result = await service.launch('c-bulk-nocf');

      expect(result.launched).toBe(150);
      expect(mockInadService.startBulkExtraction).not.toHaveBeenCalled();
      expect(mockCampaignRepo.save).not.toHaveBeenCalled();
      // Lo stato QUEUED è già stato impostato dall'update atomico iniziale di
      // launch(): non deve mai passare da CHECKING_INAD in questo caso.
      expect(mockCampaignQb.set).not.toHaveBeenCalledWith({ status: CampaignStatus.CHECKING_INAD });
    });
  });

  describe('finalizeInadCheck — batch non ancora pronto (retry manuale)', () => {
    it('non chiama getBulkResult né crea attempt se un batch pending è ancora IN_ELABORAZIONE', async () => {
      const campaignChecking = {
        ...mockCampaign,
        id: 'c-bulk-notready',
        channelType: 'EMAIL',
        status: CampaignStatus.CHECKING_INAD,
        channelConfig: {
          inadCheck: {
            mechanism: 'bulk',
            batches: [{ id: 'batch-notready', recipientIds: ['r1', 'r2'], done: false }],
            requestedAt: '2026-01-01T00:00:00Z',
          },
        },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaignChecking);
      mockInadService.getBulkState.mockResolvedValue('IN_ELABORAZIONE');

      await expect(service.finalizeInadCheck('c-bulk-notready')).resolves.not.toThrow();

      expect(mockInadService.getBulkState).toHaveBeenCalledWith('batch-notready');
      expect(mockInadService.getBulkResult).not.toHaveBeenCalled();
      expect(mockAttemptRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(mockCampaignRepo.save).not.toHaveBeenCalled();
    });

    it('con più batch pending, non processa nessun batch (nemmeno quelli già pronti) se anche uno solo non è DISPONIBILE', async () => {
      const campaignChecking = {
        ...mockCampaign,
        id: 'c-bulk-multi-notready',
        channelType: 'EMAIL',
        status: CampaignStatus.CHECKING_INAD,
        channelConfig: {
          inadCheck: {
            mechanism: 'bulk',
            batches: [
              { id: 'batch-ready', recipientIds: ['r1', 'r2'], done: false },
              { id: 'batch-notready', recipientIds: ['r3', 'r4'], done: false },
            ],
            requestedAt: '2026-01-01T00:00:00Z',
          },
        },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaignChecking);
      mockInadService.getBulkState.mockImplementation((id: string) =>
        Promise.resolve(id === 'batch-ready' ? 'DISPONIBILE' : 'IN_ELABORAZIONE'),
      );

      await expect(service.finalizeInadCheck('c-bulk-multi-notready')).resolves.not.toThrow();

      expect(mockInadService.getBulkState).toHaveBeenCalledWith('batch-ready');
      expect(mockInadService.getBulkState).toHaveBeenCalledWith('batch-notready');
      expect(mockInadService.getBulkResult).not.toHaveBeenCalled();
      expect(mockRecipientRepo.update).not.toHaveBeenCalled();
      expect(mockAttemptRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(mockCampaignRepo.save).not.toHaveBeenCalled();
      expect(mockCampaignQb.set).not.toHaveBeenCalledWith({ status: CampaignStatus.QUEUED });
    });
  });

  describe('getChannelBreakdown', () => {
    it('ritorna null se la campagna non ha né co-consegna App IO né destinatari con inadCheck', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelConfig: {} });
      mockRecipientRepo.find.mockResolvedValueOnce([
        { id: 'r1', status: RecipientStatus.SENT, inadCheck: null },
      ]);

      const result = await service.getChannelBreakdown('uuid-1');

      expect(result).toBeNull();
    });

    it('classifica correttamente le 5 categorie di consegna e il conteggio inadDiverted', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({
        ...mockCampaign,
        channelConfig: { appIo: { mode: 'parallel', ioServiceId: 'svc-1' } },
      });
      mockRecipientRepo.find.mockResolvedValueOnce([
        { id: 'r-primary-only', status: RecipientStatus.SENT, inadCheck: null },
        { id: 'r-both', status: RecipientStatus.SENT, inadCheck: { found: true, diverted: true } },
        { id: 'r-appio-only', status: RecipientStatus.SENT, inadCheck: { found: true, diverted: false } },
        { id: 'r-appio-despite-fail', status: RecipientStatus.FAILED, inadCheck: null },
        { id: 'r-neither', status: RecipientStatus.FAILED, inadCheck: null },
        { id: 'r-pending', status: RecipientStatus.PENDING, inadCheck: { found: true, diverted: true } },
      ]);
      mockAttemptRepo.find.mockResolvedValueOnce([
        { recipientId: 'r-primary-only', responsePayload: {} },
        { recipientId: 'r-both', responsePayload: { appIo: { success: true } } },
        { recipientId: 'r-appio-only', responsePayload: { appIo: { success: true }, deliveredVia: 'APP_IO' } },
        { recipientId: 'r-appio-despite-fail', responsePayload: { appIo: { success: true } } },
        { recipientId: 'r-neither', responsePayload: { appIo: { success: false, error: 'timeout' } } },
      ]);

      const result = await service.getChannelBreakdown('uuid-1');

      // inadDiverted conta SOLO diverted:true, su TUTTI i destinatari (anche
      // PENDING/non ancora inviati) — non solo SENT/FAILED come le altre
      // categorie, perché descrive una decisione di instradamento presa al
      // lancio, non un esito di invio. r-both e r-pending hanno diverted:true,
      // r-appio-only ha found:true ma diverted:false (indirizzo INAD coincideva
      // con quello già configurato) e non va contato.
      expect(result).toEqual({
        primaryOnly: 1,
        both: 1,
        appIoOnly: 1,
        appIoDespitePrimaryFail: 1,
        neither: 1,
        inadDiverted: 2,
      });
    });

    it('ritorna un breakdown (non null) con solo inadDiverted valorizzato se non c\'è App IO ma c\'è INAD', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelConfig: {} });
      mockRecipientRepo.find.mockResolvedValueOnce([
        { id: 'r1', status: RecipientStatus.SENT, inadCheck: { found: true, diverted: true } },
      ]);
      mockAttemptRepo.find.mockResolvedValueOnce([]);

      const result = await service.getChannelBreakdown('uuid-1');

      expect(result).toEqual({
        primaryOnly: 1,
        both: 0,
        appIoOnly: 0,
        appIoDespitePrimaryFail: 0,
        neither: 0,
        inadDiverted: 1,
      });
    });
  });

  describe('getEffectiveChannelBreakdown', () => {
    it('bucketizza i destinatari SENT per canale effettivo (deliveredVia APP_IO > attempt.channelType)', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelType: 'POSTAL' });
      mockRecipientRepo.find.mockResolvedValueOnce([
        { id: 'r-postal', status: RecipientStatus.SENT },
        { id: 'r-appio', status: RecipientStatus.SENT },
        { id: 'r-pec-inad', status: RecipientStatus.SENT },
        { id: 'r-failed', status: RecipientStatus.FAILED },
      ]);
      mockAttemptRepo.find.mockResolvedValueOnce([
        { recipientId: 'r-postal', channelType: 'POSTAL', responsePayload: {} },
        { recipientId: 'r-appio', channelType: 'POSTAL', responsePayload: { deliveredVia: 'APP_IO' } },
        { recipientId: 'r-pec-inad', channelType: 'PEC', responsePayload: {} },
      ]);

      const result = await service.getEffectiveChannelBreakdown('uuid-1');

      expect(result).toEqual({ POSTAL: 1, APP_IO: 1, PEC: 1 });
    });

    it('ritorna oggetto vuoto se nessun destinatario è SENT', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelType: 'EMAIL' });
      mockRecipientRepo.find.mockResolvedValueOnce([]);

      const result = await service.getEffectiveChannelBreakdown('uuid-1');

      expect(result).toEqual({});
      expect(mockAttemptRepo.find).not.toHaveBeenCalled();
    });
  });

  describe('getDownloadCombinationStats', () => {
    it('lancia NotFoundException se la campagna non esiste', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);
      await expect(service.getDownloadCombinationStats('missing')).rejects.toThrow(NotFoundException);
    });

    it('ritorna combinazioni vuote se la campagna non ha destinatari', async () => {
      mockRecipientRepo.find.mockResolvedValueOnce([]);

      const result = await service.getDownloadCombinationStats('uuid-1');

      expect(result).toEqual({ sentCount: 0, combinations: [] });
      expect(mockDownloadEventRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('raggruppa solo i destinatari notificati (SENT) per canale, esclude i falliti senza download', async () => {
      mockRecipientRepo.find.mockResolvedValueOnce([
        { id: 'r-primary', status: RecipientStatus.SENT },
        { id: 'r-portal-plus-primary', status: RecipientStatus.SENT },
        { id: 'r-sent-not-downloaded', status: RecipientStatus.SENT },
        { id: 'r-failed-no-download', status: RecipientStatus.FAILED },
      ]);
      const qbMock = {
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { recipientId: 'r-primary', channel: 'EMAIL' },
          { recipientId: 'r-portal-plus-primary', channel: 'CITIZEN_PORTAL' },
          { recipientId: 'r-portal-plus-primary', channel: 'EMAIL' },
        ]),
      };
      mockDownloadEventRepo.createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      const result = await service.getDownloadCombinationStats('uuid-1');

      // sentCount conta i notificati (3 SENT); il fallito senza download non entra nel grafico.
      expect(result.sentCount).toBe(3);
      expect(result.combinations).toEqual(
        expect.arrayContaining([
          { channels: ['EMAIL'], count: 1, sentSuccessfully: true },
          { channels: ['CITIZEN_PORTAL', 'EMAIL'], count: 1, sentSuccessfully: true },
          { channels: [], count: 1, sentSuccessfully: true },
        ]),
      );
      expect(result.combinations).toHaveLength(3);
      expect(qbMock.where).toHaveBeenCalledWith('r.campaignId = :campaignId', { campaignId: 'uuid-1' });
    });

    it('marca sentSuccessfully: false chi scarica pur non essendo notificato con successo', async () => {
      mockRecipientRepo.find.mockResolvedValueOnce([
        { id: 'r-failed-downloaded', status: RecipientStatus.FAILED },
      ]);
      const qbMock = {
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ recipientId: 'r-failed-downloaded', channel: 'CITIZEN_PORTAL' }]),
      };
      mockDownloadEventRepo.createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      const result = await service.getDownloadCombinationStats('uuid-1');

      expect(result.sentCount).toBe(0);
      expect(result.combinations).toEqual([{ channels: ['CITIZEN_PORTAL'], count: 1, sentSuccessfully: false }]);
    });

    it('considera notificato con successo il fallito primario con App IO co-consegna riuscita (payload primo tentativo)', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({
        ...mockCampaign,
        channelConfig: { appIo: { mode: 'parallel', ioServiceId: 'svc-1' } },
      });
      mockRecipientRepo.find.mockResolvedValueOnce([{ id: 'r-appio-despite-fail', status: RecipientStatus.FAILED }]);
      mockAttemptRepo.find = jest.fn().mockResolvedValueOnce([
        { recipientId: 'r-appio-despite-fail', responsePayload: { appIo: { success: true } } },
      ]);
      const qbMock = {
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([{ recipientId: 'r-appio-despite-fail', channel: 'APP_IO' }]),
      };
      mockDownloadEventRepo.createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      const result = await service.getDownloadCombinationStats('uuid-1');

      expect(mockAttemptRepo.find).toHaveBeenCalledWith({
        where: { recipientId: In(['r-appio-despite-fail']), attemptNumber: 1 },
        select: ['recipientId', 'responsePayload'],
      });
      expect(result.sentCount).toBe(1);
      expect(result.combinations).toEqual([{ channels: ['APP_IO'], count: 1, sentSuccessfully: true }]);
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
        .mockReturnValueOnce(makeQb({ rawMany: [{ date: '2026-07-05', sent: '12', failed: '2' }] }))
        .mockReturnValueOnce(makeQb({ rawMany: [{ channel: 'EMAIL', sent: '90' }] }))
        .mockReturnValueOnce(makeQb({ rawMany: [{ campaignId: 'c1', campaignName: 'Tari', totalRecipients: '100', downloadedCount: '60' }] }));

      mockRecipientRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(makeQb({ count: 60 }))
        .mockReturnValueOnce(makeQb({ rawMany: [{ month: '2026-06', downloaded: '30' }] }))
        .mockReturnValueOnce(makeQb({ count: 15 }))
        .mockReturnValueOnce(makeQb({ rawMany: [] }));

      mockDownloadEventRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(makeQb({ rawMany: [{ channel: 'EMAIL', count: '55' }] }));

      mockAttemptRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(makeQb({ rawOne: { totalCostCents: '2431' } }));

      const result = await service.getGlobalStats('2026-06-01', '2026-07-08');

      expect(result.totals).toEqual({
        totalRecipients: 100,
        totalSent: 90,
        totalFailed: 10,
        totalDownloaded: 60,
        downloadPercentage: 60,
        totalCostCents: 2431,
        totalSavingCents: 0,
      });
      expect(result.monthlyTrend).toEqual([
        { month: '2026-06', sent: 50, downloaded: 30 },
        { month: '2026-07', sent: 40, downloaded: 0 },
      ]);
      expect(result.dailyTrend).toEqual([
        { date: '2026-07-05', sent: 12, failed: 2 },
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
        .mockReturnValueOnce(makeQb({ rawMany: [] }))
        .mockReturnValueOnce(makeQb({ rawMany: [] }));
      mockRecipientRepo.createQueryBuilder = jest
        .fn()
        .mockReturnValueOnce(makeQb({ count: 0 }))
        .mockReturnValueOnce(makeQb({ rawMany: [] }))
        .mockReturnValueOnce(makeQb({ count: 0 }))
        .mockReturnValueOnce(makeQb({ rawMany: [] }));
      mockDownloadEventRepo.createQueryBuilder = jest.fn().mockReturnValueOnce(makeQb({ rawMany: [] }));
      mockAttemptRepo.createQueryBuilder = jest.fn().mockReturnValueOnce(makeQb({ rawOne: undefined }));

      const result = await service.getGlobalStats();

      expect(result.totals).toEqual({
        totalRecipients: 0,
        totalSent: 0,
        totalFailed: 0,
        totalDownloaded: 0,
        downloadPercentage: 0,
        totalCostCents: 0,
        totalSavingCents: 0,
      });
      expect(result.monthlyTrend).toEqual([]);
      expect(result.dailyTrend).toEqual([]);
      expect(result.campaignLeaderboard).toEqual([]);
    });

    it('esclude sempre le campagne isTest=true da ognuna delle 11 query aggregate', async () => {
      const createdQbs: any[] = [];
      const trackedMakeQb = (terminal: { rawOne?: any; rawMany?: any[]; count?: number }) => {
        const qb = makeQb(terminal);
        createdQbs.push(qb);
        return qb;
      };

      mockCampaignRepo.createQueryBuilder = jest
        .fn()
        .mockImplementationOnce(() => trackedMakeQb({ rawOne: { totalRecipients: '0', totalSent: '0', totalFailed: '0' } })) // totalsRow
        .mockImplementationOnce(() => trackedMakeQb({ rawMany: [] })) // sentTrendRows
        .mockImplementationOnce(() => trackedMakeQb({ rawMany: [] })) // dailyTrendRows
        .mockImplementationOnce(() => trackedMakeQb({ rawMany: [] })) // channelRows
        .mockImplementationOnce(() => trackedMakeQb({ rawMany: [] })); // leaderboardRows

      mockRecipientRepo.createQueryBuilder = jest
        .fn()
        .mockImplementationOnce(() => trackedMakeQb({ count: 0 })) // totalDownloaded
        .mockImplementationOnce(() => trackedMakeQb({ rawMany: [] })) // downloadedTrendRows
        .mockImplementationOnce(() => trackedMakeQb({ count: 0 })) // neverDownloadedCount
        .mockImplementationOnce(() => trackedMakeQb({ rawMany: [] })); // savingRow

      mockDownloadEventRepo.createQueryBuilder = jest
        .fn()
        .mockImplementationOnce(() => trackedMakeQb({ rawMany: [] })); // downloadChannelRows

      mockAttemptRepo.createQueryBuilder = jest
        .fn()
        .mockImplementationOnce(() => trackedMakeQb({ rawOne: { totalCostCents: '0' } })); // costRow

      await service.getGlobalStats();

      expect(createdQbs).toHaveLength(11);
      const [
        totalsRowQb,
        totalDownloadedQb,
        sentTrendQb,
        dailyTrendQb,
        downloadedTrendQb,
        channelQb,
        downloadChannelQb,
        leaderboardQb,
        neverDownloadedQb,
        costRowQb,
        savingRowQb,
      ] = createdQbs;

      const names = [
        ['totalsRow', totalsRowQb],
        ['totalDownloaded', totalDownloadedQb],
        ['sentTrendRows', sentTrendQb],
        ['dailyTrendRows', dailyTrendQb],
        ['downloadedTrendRows', downloadedTrendQb],
        ['channelRows', channelQb],
        ['downloadChannelRows', downloadChannelQb],
        ['leaderboardRows', leaderboardQb],
        ['neverDownloadedCount', neverDownloadedQb],
        ['costRow', costRowQb],
        ['savingRow', savingRowQb],
      ] as const;

      for (const [name, qb] of names) {
        const andWhereCalls = qb.andWhere.mock.calls.map((c: unknown[]) => c[0]);
        expect({ queryBuilder: name, hasIsTestFilter: andWhereCalls.includes('c.isTest = false') }).toEqual({
          queryBuilder: name,
          hasIsTestFilter: true,
        });
      }
    });
  });

  describe('getNeverDownloadedRecipients', () => {
    it('mappa i destinatari sent con downloadCount=0 nel periodo', async () => {
      const qb: any = {};
      ['innerJoinAndSelect', 'where', 'andWhere', 'orderBy'].forEach((m) => {
        qb[m] = jest.fn().mockReturnValue(qb);
      });
      qb.getMany = jest.fn().mockResolvedValue([
        {
          codiceFiscale: 'AAA1',
          fullName: 'Mario Rossi',
          status: RecipientStatus.SENT,
          createdAt: new Date('2026-06-01T10:00:00Z'),
          campaign: { name: 'Tari 2026', channelType: 'EMAIL' },
        },
      ]);
      mockRecipientRepo.createQueryBuilder = jest.fn().mockReturnValue(qb);

      const result = await service.getNeverDownloadedRecipients('2026-06-01', '2026-07-08');

      expect(result).toEqual([
        {
          codiceFiscale: 'AAA1',
          fullName: 'Mario Rossi',
          campaignName: 'Tari 2026',
          channelType: 'EMAIL',
          status: 'sent',
          createdAt: '2026-06-01T10:00:00.000Z',
        },
      ]);
      expect(qb.andWhere).toHaveBeenCalledWith('r.status = :status', { status: RecipientStatus.SENT });
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

  describe('remove — cascata su campagna test collegata', () => {
    it('cancella anche la campagna test figlia quando esiste', async () => {
      mockCampaignRepo.existsBy.mockResolvedValueOnce(true);
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ id: 'child-1', parentCampaignId: 'parent-1', isTest: true });
      mockRecipientRepo.find.mockResolvedValueOnce([{ id: 'r1' }]);
      const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);

      await service.remove('parent-1');

      expect(mockCampaignRepo.findOneBy).toHaveBeenCalledWith({ parentCampaignId: 'parent-1', isTest: true });
      expect(mockAttemptRepo.delete).toHaveBeenCalledWith({ recipientId: In(['r1']) });
      expect(mockRecipientRepo.delete).toHaveBeenCalledWith({ id: In(['r1']) });
      expect(mockCampaignRepo.delete).toHaveBeenCalledWith('child-1');
      expect(mockCampaignRepo.delete).toHaveBeenCalledWith('parent-1');

      rmSpy.mockRestore();
    });

    it('nessuna campagna test collegata: cancella solo la campagna madre, nessuna chiamata extra', async () => {
      mockCampaignRepo.existsBy.mockResolvedValueOnce(true);
      mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);
      const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);

      await service.remove('parent-2');

      expect(mockCampaignRepo.findOneBy).toHaveBeenCalledWith({ parentCampaignId: 'parent-2', isTest: true });
      expect(mockAttemptRepo.delete).not.toHaveBeenCalled();
      expect(mockRecipientRepo.delete).not.toHaveBeenCalled();
      expect(mockCampaignRepo.delete).toHaveBeenCalledTimes(1);
      expect(mockCampaignRepo.delete).toHaveBeenCalledWith('parent-2');

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

    it('lancia BadRequestException se la campagna non e QUEUED ne CHECKING_INAD', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, status: CampaignStatus.DRAFT });
      await expect(service.cancel('c1')).rejects.toThrow('Solo campagne in corso o in verifica INAD possono essere annullate');
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

    it('per campagne SEND annulla via update diretto DB, senza toccare BullMQ canale, ma rimuove i job PROTOCOLLAZIONE pendenti', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, id: 'c1', status: CampaignStatus.QUEUED, channelType: 'SEND' });
      mockRecipientRepo.find.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]);
      mockAttemptRepo.find = jest.fn().mockResolvedValueOnce([
        { id: 'att-1', recipientId: 'r1' },
        { id: 'att-2', recipientId: 'r2' },
      ]);
      const updateQb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ raw: [{ id: 'att-1' }, { id: 'att-2' }] }),
      };
      mockAttemptRepo.createQueryBuilder = jest.fn().mockReturnValue(updateQb);
      mockRecipientRepo.update = jest.fn().mockResolvedValue(undefined);
      const removeOk = jest.fn().mockResolvedValue(undefined);
      mockQueue.getJob.mockResolvedValue({ id: 'job', remove: removeOk });

      const result = await service.cancel('c1');

      expect(updateQb.set).toHaveBeenCalledWith({ status: AttemptStatus.CANCELLED });
      expect(updateQb.where).toHaveBeenCalledWith(
        'id IN (:...ids) AND status = :status',
        { ids: ['att-1', 'att-2'], status: AttemptStatus.QUEUED },
      );
      expect(mockQueue.getJob).toHaveBeenCalledWith('PROTOCOLLAZIONE', 'att-1');
      expect(mockQueue.getJob).toHaveBeenCalledWith('PROTOCOLLAZIONE', 'att-2');
      expect(removeOk).toHaveBeenCalledTimes(2);
      expect(mockRecipientRepo.update).toHaveBeenCalledWith({ id: In(['r1', 'r2']) }, { status: RecipientStatus.CANCELLED });
      expect(result).toEqual({ cancelled: 2, campaignId: 'c1' });
    });

    it('per campagne SEND non fallisce se il job PROTOCOLLAZIONE non esiste più (già consumato)', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, id: 'c1', status: CampaignStatus.QUEUED, channelType: 'SEND' });
      mockRecipientRepo.find.mockResolvedValueOnce([{ id: 'r1' }]);
      mockAttemptRepo.find = jest.fn().mockResolvedValueOnce([
        { id: 'att-1', recipientId: 'r1' },
      ]);
      const updateQb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ raw: [{ id: 'att-1' }] }),
      };
      mockAttemptRepo.createQueryBuilder = jest.fn().mockReturnValue(updateQb);
      mockRecipientRepo.update = jest.fn().mockResolvedValue(undefined);
      mockQueue.getJob.mockResolvedValueOnce(null);

      await expect(service.cancel('c1')).resolves.toEqual({ cancelled: 1, campaignId: 'c1' });
    });

    it('per campagne SEND annulla solo i recipient il cui attempt è ancora QUEUED al momento dell\'update (race col demone invio)', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, id: 'c1', status: CampaignStatus.QUEUED, channelType: 'SEND' });
      mockRecipientRepo.find.mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }]);
      mockAttemptRepo.find = jest.fn().mockResolvedValueOnce([
        { id: 'att-1', recipientId: 'r1' },
        { id: 'att-2', recipientId: 'r2' },
      ]);
      // Il demone SendDispatchService ha già marcato att-2 SUCCESS tra la find()
      // e questo update: l'UPDATE guardato su status=QUEUED tocca solo att-1.
      const updateQb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ raw: [{ id: 'att-1' }] }),
      };
      mockAttemptRepo.createQueryBuilder = jest.fn().mockReturnValue(updateQb);
      mockRecipientRepo.update = jest.fn().mockResolvedValue(undefined);

      const result = await service.cancel('c1');

      expect(mockRecipientRepo.update).toHaveBeenCalledWith({ id: In(['r1']) }, { status: RecipientStatus.CANCELLED });
      expect(mockRecipientRepo.update).not.toHaveBeenCalledWith({ id: In(['r1', 'r2']) }, expect.anything());
      expect(result).toEqual({ cancelled: 1, campaignId: 'c1' });
    });
  });

  describe('cancel — da CHECKING_INAD', () => {
    it('permette annullamento da CHECKING_INAD senza toccare job/attempt', async () => {
      const campaignChecking = { ...mockCampaign, id: 'c-cancel-inad', status: CampaignStatus.CHECKING_INAD };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaignChecking);
      mockRecipientRepo.find.mockResolvedValue([]);
      mockCampaignQb.execute.mockResolvedValue({ affected: 1 });

      const result = await service.cancel('c-cancel-inad');

      expect(result.campaignId).toBe('c-cancel-inad');
      expect(mockCampaignQb.set).toHaveBeenCalledWith(expect.objectContaining({ status: CampaignStatus.CANCELLED }));
    });
  });

  describe('skipInadCheck', () => {
    it('salta la verifica INAD e lancia con i canali originali', async () => {
      const campaignChecking = {
        ...mockCampaign,
        id: 'c-skip-1',
        channelType: 'EMAIL',
        status: CampaignStatus.CHECKING_INAD,
        channelConfig: {},
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaignChecking);
      mockRecipientRepo.find.mockResolvedValue([{ id: 'r1' }]);
      mockAttemptRepo.createQueryBuilder.mockReturnValue({
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ raw: [{ id: 'att-1' }] }),
      });

      const result = await service.skipInadCheck('c-skip-1');

      expect(result.launched).toBe(1);
      expect(mockCampaignRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: CampaignStatus.QUEUED }));
    });

    it('rifiuta se la campagna non è in CHECKING_INAD', async () => {
      const campaignQueued = { ...mockCampaign, id: 'c-skip-2', status: CampaignStatus.QUEUED };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaignQueued);
      await expect(service.skipInadCheck('c-skip-2')).rejects.toThrow(BadRequestException);
    });

    it('non ricrea gli attempt se un\'altra invocazione concorrente ha già vinto la transizione', async () => {
      const campaignChecking = {
        ...mockCampaign,
        id: 'c-skip-race',
        channelType: 'EMAIL',
        status: CampaignStatus.CHECKING_INAD,
        channelConfig: {},
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaignChecking);
      mockCampaignQb.execute.mockResolvedValueOnce({ affected: 0 });

      const result = await service.skipInadCheck('c-skip-race');

      expect(result).toEqual({ launched: 0, campaignId: 'c-skip-race' });
      expect(mockRecipientRepo.find).not.toHaveBeenCalled();
    });
  });

  describe('CampaignsService.getSendStageCounts', () => {
    it('conta gli attempt SEND per stadio, filtrati per campagna', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ id: 'camp-1', channelType: 'SEND' });
      const mockQb = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getCount: jest.fn()
          .mockResolvedValueOnce(3)  // queued (non protocollato)
          .mockResolvedValueOnce(2)  // protocollato non inviato
          .mockResolvedValueOnce(10) // inviato
          .mockResolvedValueOnce(1), // fallito
      };
      mockAttemptRepo.createQueryBuilder.mockReturnValue(mockQb);

      const result = await service.getSendStageCounts('camp-1');

      expect(result).toEqual({ queued: 3, protocollato: 2, inviato: 10, fallito: 1 });
    });

    it('lancia NotFoundException se la campagna non esiste', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);
      await expect(service.getSendStageCounts('camp-inesistente')).rejects.toThrow(NotFoundException);
    });

    it('non filtra per channel_type — include anche i destinatari overridden da INAD (canale diverso da quello di campagna)', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ id: 'camp-1', channelType: 'EMAIL' });
      const andWhereCalls: any[] = [];
      const mockQb = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockImplementation((...args) => { andWhereCalls.push(args); return mockQb; }),
        getCount: jest.fn().mockResolvedValue(0),
      };
      mockAttemptRepo.createQueryBuilder.mockReturnValue(mockQb);

      await service.getSendStageCounts('camp-1');

      const filtersOnChannelType = andWhereCalls.some(([sql]) => typeof sql === 'string' && sql.includes('channel_type'));
      expect(filtersOnChannelType).toBe(false);
    });
  });

  describe('launchTestSend', () => {
    it('crea una campagna figlia isTest=true al primo invio di prova', async () => {
      const parent = {
        id: 'parent-1',
        name: 'Campagna TARI 2026',
        channelType: 'EMAIL',
        channelConfig: { subject: 'Avviso', body: 'Corpo' },
        createdBy: 'operator1',
      };
      mockCampaignRepo.findOneBy
        .mockResolvedValueOnce(parent) // findOneBy({id: parentCampaignId})
        .mockResolvedValueOnce(null); // findOneBy({parentCampaignId, isTest: true}) -> nessun child esistente
      mockCampaignRepo.create.mockReturnValue({ ...parent, id: 'child-1', isTest: true, parentCampaignId: 'parent-1' });
      mockCampaignRepo.save.mockResolvedValue({ ...parent, id: 'child-1', isTest: true, parentCampaignId: 'parent-1' });
      mockRecipientRepo.create.mockReturnValue({ id: 'recipient-1' });
      mockRecipientRepo.save.mockResolvedValue({ id: 'recipient-1' });

      const insertResult = { raw: [{ id: 'attempt-1' }] };
      mockAttemptRepo.createQueryBuilder.mockReturnValue({
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(insertResult),
      });
      mockRecipientRepo.update.mockResolvedValue(undefined);
      mockAttemptRepo.findOne.mockResolvedValue({ id: 'attempt-1' });
      mockQueue.addBulk.mockResolvedValue(undefined);

      const dto = { codiceFiscale: 'RSSMRA80A01H501U', email: 'test@example.com', extraData: { full_name: 'Mario Rossi' } };
      const result = await service.launchTestSend('parent-1', dto);

      expect(result.testCampaignId).toBe('child-1');
      expect(result.attemptId).toBeTruthy();
      expect(mockCampaignRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isTest: true, parentCampaignId: 'parent-1', name: '[TEST] Campagna TARI 2026' }),
      );
    });

    it('riusa la campagna figlia esistente al secondo invio di prova, aggiornando channelConfig', async () => {
      const parent = {
        id: 'parent-1',
        name: 'Campagna TARI 2026',
        channelType: 'EMAIL',
        channelConfig: { subject: 'Nuovo oggetto' },
        createdBy: 'operator1',
      };
      const existingChild = { id: 'child-1', isTest: true, parentCampaignId: 'parent-1', channelType: 'EMAIL', channelConfig: {} };
      mockCampaignRepo.findOneBy.mockResolvedValueOnce(parent).mockResolvedValueOnce(existingChild);
      mockCampaignRepo.update.mockResolvedValue(undefined);
      mockRecipientRepo.create.mockReturnValue({ id: 'recipient-2' });
      mockRecipientRepo.save.mockResolvedValue({ id: 'recipient-2' });

      const insertResult = { raw: [{ id: 'attempt-2' }] };
      mockAttemptRepo.createQueryBuilder.mockReturnValue({
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(insertResult),
      });
      mockRecipientRepo.update.mockResolvedValue(undefined);
      mockAttemptRepo.findOne.mockResolvedValue({ id: 'attempt-2' });
      mockQueue.addBulk.mockResolvedValue(undefined);

      const dto = { codiceFiscale: 'VRDLGU85B02H501X', extraData: {} };
      const result = await service.launchTestSend('parent-1', dto);

      expect(result.testCampaignId).toBe('child-1');
      expect(mockCampaignRepo.create).not.toHaveBeenCalled();
      expect(mockCampaignRepo.update).toHaveBeenCalledWith({ id: 'child-1' }, { channelConfig: parent.channelConfig });
    });

    it('SEND senza protocolla lancia BadRequestException, nessuna campagna figlia creata', async () => {
      const parent = { id: 'parent-1', name: 'Campagna SEND', channelType: 'SEND', channelConfig: {}, createdBy: 'operator1' };
      mockCampaignRepo.findOneBy.mockResolvedValueOnce(parent);

      await expect(service.launchTestSend('parent-1', { codiceFiscale: 'RSSMRA80A01H501U', extraData: {} }))
        .rejects.toThrow('Protocollazione obbligatoria per SEND');
      expect(mockCampaignRepo.create).not.toHaveBeenCalled();
    });

    describe('con cartelle upload reali su disco', () => {
      let parentDir: string;
      let childDir: string;

      beforeEach(() => {
        parentDir = fs.mkdtempSync(join(os.tmpdir(), 'comunicapa-testsend-parent-'));
        childDir = fs.mkdtempSync(join(os.tmpdir(), 'comunicapa-testsend-child-'));
        (getUploadsDir as jest.Mock).mockImplementation((id: string) => (id === 'parent-1' ? parentDir : childDir));
      });

      afterEach(() => {
        fs.rmSync(parentDir, { recursive: true, force: true });
        fs.rmSync(childDir, { recursive: true, force: true });
      });

      it('copia fisicamente gli allegati dalla cartella upload della madre a quella della figlia, svuotandola prima', async () => {
        const parent = { id: 'parent-1', name: 'Campagna TARI 2026', channelType: 'EMAIL', channelConfig: {}, createdBy: 'operator1' };
        mockCampaignRepo.findOneBy
          .mockResolvedValueOnce(parent) // findOneBy({id: parentCampaignId})
          .mockResolvedValueOnce(null); // nessun child esistente
        mockCampaignRepo.create.mockReturnValue({ ...parent, id: 'child-1', isTest: true, parentCampaignId: 'parent-1' });
        mockCampaignRepo.save.mockResolvedValue({ ...parent, id: 'child-1', isTest: true, parentCampaignId: 'parent-1' });
        mockRecipientRepo.create.mockReturnValue({ id: 'recipient-1' });
        mockRecipientRepo.save.mockResolvedValue({ id: 'recipient-1' });
        mockAttemptRepo.createQueryBuilder.mockReturnValue({
          insert: jest.fn().mockReturnThis(),
          into: jest.fn().mockReturnThis(),
          values: jest.fn().mockReturnThis(),
          returning: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ raw: [{ id: 'attempt-1' }] }),
        });
        mockAttemptRepo.findOne.mockResolvedValue({ id: 'attempt-1' });
        mockQueue.addBulk.mockResolvedValue(undefined);

        // Cartella madre con un allegato reale; cartella figlia con un file
        // stantio da una precedente prova, deve essere svuotata prima della copia.
        fs.writeFileSync(join(parentDir, 'avviso.pdf'), '%PDF');
        fs.writeFileSync(join(childDir, 'vecchio.pdf'), 'stale');

        await service.launchTestSend('parent-1', { codiceFiscale: 'RSSMRA80A01H501U', extraData: {} });

        expect(fs.existsSync(join(childDir, 'vecchio.pdf'))).toBe(false);
        expect(fs.existsSync(join(childDir, 'avviso.pdf'))).toBe(true);
        expect(fs.readFileSync(join(childDir, 'avviso.pdf'), 'utf8')).toBe('%PDF');
      });

      it("SEND: blocca il test-send se manca l'allegato mappato per il destinatario di prova appena creato — verifica il riordino (recipient creato prima del check allegati)", async () => {
        const parent = {
          id: 'parent-1',
          name: 'Campagna SEND',
          channelType: 'SEND',
          channelConfig: { protocolla: true, attachments: [{ key: 'file', label: 'Avviso' }] },
          createdBy: 'operator1',
        };
        const existingChild = {
          id: 'child-1',
          isTest: true,
          parentCampaignId: 'parent-1',
          channelType: 'SEND',
          channelConfig: {},
        };
        mockCampaignRepo.findOneBy.mockResolvedValueOnce(parent).mockResolvedValueOnce(existingChild);
        mockCampaignRepo.update.mockResolvedValue(undefined);

        const testRecipient = { id: 'recipient-test', campaignId: 'child-1', codiceFiscale: 'RSSMRA80A01H501U', extraData: { file: 'xyz.pdf' } };
        mockRecipientRepo.create.mockReturnValue(testRecipient);
        mockRecipientRepo.save.mockResolvedValue(testRecipient);
        // findMissingAttachments interroga i recipient PENDING della figlia: deve
        // vedere ESATTAMENTE il destinatario appena creato (non uno vuoto, non uno
        // stantio) — se il riordino del fix venisse invertito, questo mock non
        // verrebbe nemmeno raggiunto prima del check, e il blocco non scatterebbe
        // mai (nessun PENDING trovato), facendo fallire questo test.
        mockRecipientRepo.find.mockResolvedValueOnce([
          { id: 'recipient-test', codiceFiscale: 'RSSMRA80A01H501U', extraData: { file: 'xyz.pdf' } },
        ]);

        // Nessun file nella cartella madre/figlia: 'xyz.pdf' atteso dal CF di
        // prova non è presente -> findMissingAttachments deve segnalarlo.

        const result = await service.launchTestSend('parent-1', {
          codiceFiscale: 'RSSMRA80A01H501U',
          extraData: { file: 'xyz.pdf' },
        });

        expect(result.blocked).toBe(true);
        expect(result.message).toContain('Impossibile avviare');
        // Il recipient di prova È stato creato (prerequisito del fix — riordino),
        // ma viene ripulito perché il blocco è scattato.
        expect(mockRecipientRepo.save).toHaveBeenCalled();
        expect(mockRecipientRepo.delete).toHaveBeenCalledWith({ id: 'recipient-test' });
        // Nessun invio reale: createAttemptsAndEnqueue non deve mai essere raggiunto.
        expect(mockQueue.addBulk).not.toHaveBeenCalled();
      });
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
        { provide: InadService, useValue: { extractDigitalAddress: jest.fn(), startBulkExtraction: jest.fn() } },
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
  const recipientRepoMock = { findOne: jest.fn(), update: jest.fn(), find: jest.fn(), createQueryBuilder: jest.fn() };
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
        { provide: InadService, useValue: { extractDigitalAddress: jest.fn(), startBulkExtraction: jest.fn() } },
      ],
    }).compile();

  it('getFailures ritorna solo i destinatari il cui stato attuale è FAILED, con ultimo tentativo', async () => {
    const qb: any = {};
    ['leftJoin', 'select', 'addSelect', 'where', 'andWhere', 'orderBy'].forEach((m) => {
      qb[m] = jest.fn().mockReturnValue(qb);
    });
    qb.getRawMany = jest.fn().mockResolvedValue([
      {
        recipientId: 'r1',
        codiceFiscale: 'RSSMRA80A01H501X',
        fullName: 'Mario Rossi',
        errorMessage: 'SMTP timeout',
        attemptNumber: 2,
        lastAttemptAt: new Date('2026-07-01T10:00:00Z'),
        recipientCreatedAt: new Date('2026-06-30T00:00:00Z'),
      },
    ]);
    recipientRepoMock.createQueryBuilder = jest.fn().mockReturnValue(qb);
    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    const result = await service.getFailures('c1');

    expect(recipientRepoMock.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(qb.where).toHaveBeenCalledWith('r.campaignId = :campaignId', { campaignId: 'c1' });
    expect(qb.andWhere).toHaveBeenCalledWith('r.status = :status', { status: RecipientStatus.FAILED });
    expect(result).toEqual([{
      recipientId: 'r1',
      codiceFiscale: 'RSSMRA80A01H501X',
      fullName: 'Mario Rossi',
      errorMessage: 'SMTP timeout',
      attemptNumber: 2,
      lastAttemptAt: '2026-07-01T10:00:00.000Z',
    }]);
  });

  it('getFailures usa una query aggregata invece di una findOne per destinatario (no N+1)', async () => {
    const qb: any = {};
    ['leftJoin', 'select', 'addSelect', 'where', 'andWhere', 'orderBy'].forEach((m) => {
      qb[m] = jest.fn().mockReturnValue(qb);
    });
    qb.getRawMany = jest.fn().mockResolvedValue([
      {
        recipientId: 'r1',
        codiceFiscale: 'AAA1',
        fullName: 'Mario Rossi',
        errorMessage: 'timeout',
        attemptNumber: 2,
        lastAttemptAt: new Date('2026-07-01T10:00:00Z'),
        recipientCreatedAt: new Date('2026-06-30T09:00:00Z'),
      },
      {
        recipientId: 'r2',
        codiceFiscale: 'BBB2',
        fullName: null,
        errorMessage: null,
        attemptNumber: null,
        lastAttemptAt: null,
        recipientCreatedAt: new Date('2026-06-30T09:05:00Z'),
      },
    ]);
    recipientRepoMock.createQueryBuilder = jest.fn().mockReturnValue(qb);
    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    const result = await service.getFailures('c1');

    expect(recipientRepoMock.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(attemptRepoMock.findOne).not.toHaveBeenCalled();
    expect(result).toEqual([
      { recipientId: 'r1', codiceFiscale: 'AAA1', fullName: 'Mario Rossi', errorMessage: 'timeout', attemptNumber: 2, lastAttemptAt: '2026-07-01T10:00:00.000Z' },
      { recipientId: 'r2', codiceFiscale: 'BBB2', fullName: null, errorMessage: null, attemptNumber: 0, lastAttemptAt: '2026-06-30T09:05:00.000Z' },
    ]);
  });

  it('getFailures non ritorna un destinatario FAILED poi ritentato con successo (SENT)', async () => {
    // Il destinatario r1 è stato ritentato con successo: il suo stato attuale è SENT,
    // quindi la query su Recipient con status FAILED non lo include più anche se
    // esiste ancora una NotificationAttempt storica con status FAILED per lui.
    const qb: any = {};
    ['leftJoin', 'select', 'addSelect', 'where', 'andWhere', 'orderBy'].forEach((m) => {
      qb[m] = jest.fn().mockReturnValue(qb);
    });
    qb.getRawMany = jest.fn().mockResolvedValue([]);
    recipientRepoMock.createQueryBuilder = jest.fn().mockReturnValue(qb);
    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    const result = await service.getFailures('c1');

    expect(qb.where).toHaveBeenCalledWith('r.campaignId = :campaignId', { campaignId: 'c1' });
    expect(qb.andWhere).toHaveBeenCalledWith('r.status = :status', { status: RecipientStatus.FAILED });
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

  it('retryRecipient preserva il canale overridden da INAD (PEC) invece del canale di campagna (EMAIL)', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'EMAIL', channelConfig: {} });
    recipientRepoMock.findOne = jest.fn().mockResolvedValue({ id: 'r1', campaignId: 'c1', status: RecipientStatus.FAILED });
    attemptRepoMock.findOne = jest.fn().mockResolvedValue({ attemptNumber: 1, channelType: 'PEC' });
    const insertExec = jest.fn().mockResolvedValue({ raw: [{ id: 'attempt-2' }] });
    let insertedValues: any;
    attemptRepoMock.createQueryBuilder.mockReturnValue({
      insert: () => ({ into: () => ({ values: (v: any) => { insertedValues = v; return { returning: () => ({ execute: insertExec }) }; } }) }),
    });
    recipientRepoMock.update.mockResolvedValue({ affected: 1 });

    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    await service.retryRecipient('c1', 'r1');

    expect(insertedValues.channelType).toBe('PEC');
    expect(queuesMock.addBulk).toHaveBeenCalledWith('PEC', [
      { name: 'send', data: { campaignId: 'c1', recipientId: 'r1', attemptId: 'attempt-2', channel: 'PEC' }, opts: { jobId: 'attempt-2' } },
    ]);
  });

  it('retryRecipient NON riaccoda job sul motore canale per campagne SEND (accoda invece PROTOCOLLAZIONE)', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'SEND' });
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

    expect(queuesMock.addBulk).not.toHaveBeenCalledWith('SEND', expect.anything());
    expect(queuesMock.addBulk).toHaveBeenCalledWith('PROTOCOLLAZIONE', [
      { name: 'send', data: { campaignId: 'c1', recipientId: 'r1', attemptId: 'attempt-2', channel: 'SEND' }, opts: { jobId: 'attempt-2' } },
    ]);
    expect(result).toEqual({ requeued: true, attemptId: 'attempt-2' });
  });

  it('retryRecipient per SEND eredita protocolNumber/protocolYear/protocolledAt se l\'ultimo attempt era già protocollato', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'SEND' });
    recipientRepoMock.findOne = jest.fn().mockResolvedValue({ id: 'r1', campaignId: 'c1', status: RecipientStatus.FAILED });
    const protocolledAt = new Date('2026-07-14T09:16:25.603Z');
    attemptRepoMock.findOne = jest.fn().mockResolvedValue({
      attemptNumber: 1,
      protocolNumber: 44919,
      protocolYear: 2026,
      protocolledAt,
    });
    const valuesFn = jest.fn().mockReturnThis();
    const insertExec = jest.fn().mockResolvedValue({ raw: [{ id: 'attempt-2' }] });
    attemptRepoMock.createQueryBuilder.mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: valuesFn,
      returning: jest.fn().mockReturnThis(),
      execute: insertExec,
    });
    recipientRepoMock.update.mockResolvedValue({ affected: 1 });

    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    await service.retryRecipient('c1', 'r1');

    expect(valuesFn).toHaveBeenCalledWith(expect.objectContaining({
      protocolNumber: 44919,
      protocolYear: 2026,
      protocolledAt,
    }));
    // Protocollo ereditato: nessun bisogno di riprotocollare, nessun job accodato.
    expect(queuesMock.addBulk).not.toHaveBeenCalled();
  });

  it('retryRecipient per SEND NON eredita protocollo se l\'ultimo attempt non era mai stato protocollato', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'SEND' });
    recipientRepoMock.findOne = jest.fn().mockResolvedValue({ id: 'r1', campaignId: 'c1', status: RecipientStatus.FAILED });
    attemptRepoMock.findOne = jest.fn().mockResolvedValue({ attemptNumber: 1, protocolNumber: null, protocolYear: null, protocolledAt: null });
    const valuesFn = jest.fn().mockReturnThis();
    const insertExec = jest.fn().mockResolvedValue({ raw: [{ id: 'attempt-2' }] });
    attemptRepoMock.createQueryBuilder.mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: valuesFn,
      returning: jest.fn().mockReturnThis(),
      execute: insertExec,
    });
    recipientRepoMock.update.mockResolvedValue({ affected: 1 });

    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    await service.retryRecipient('c1', 'r1');

    const insertedValues = valuesFn.mock.calls[0][0];
    expect(insertedValues.protocolNumber).toBeUndefined();
    expect(insertedValues.protocolYear).toBeUndefined();
    expect(insertedValues.protocolledAt).toBeUndefined();
    // Nessun protocollo ereditato: va (ri)protocollato dal motore dedicato.
    expect(queuesMock.addBulk).toHaveBeenCalledWith('PROTOCOLLAZIONE', [
      { name: 'send', data: { campaignId: 'c1', recipientId: 'r1', attemptId: 'attempt-2', channel: 'SEND' }, opts: { jobId: 'attempt-2' } },
    ]);
  });

  it('retryRecipient per SEND eredita uploadedDocuments se l\'ultimo attempt aveva già caricato allegati', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'SEND' });
    recipientRepoMock.findOne = jest.fn().mockResolvedValue({ id: 'r1', campaignId: 'c1', status: RecipientStatus.FAILED });
    const protocolledAt = new Date('2026-07-14T09:16:25.603Z');
    const uploadedDocuments = [{ docIdx: 0, key: 'key-old', versionToken: 'vt-old', sha256Base64: 'sha-old==' }];
    attemptRepoMock.findOne = jest.fn().mockResolvedValue({
      attemptNumber: 1,
      protocolNumber: 44919,
      protocolYear: 2026,
      protocolledAt,
      uploadedDocuments,
    });
    const valuesFn = jest.fn().mockReturnThis();
    const insertExec = jest.fn().mockResolvedValue({ raw: [{ id: 'attempt-2' }] });
    attemptRepoMock.createQueryBuilder.mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: valuesFn,
      returning: jest.fn().mockReturnThis(),
      execute: insertExec,
    });
    recipientRepoMock.update.mockResolvedValue({ affected: 1 });

    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    await service.retryRecipient('c1', 'r1');

    expect(valuesFn).toHaveBeenCalledWith(expect.objectContaining({ uploadedDocuments }));
  });

  it('retryRecipient per SEND NON eredita uploadedDocuments se l\'ultimo attempt non aveva caricato nulla', async () => {
    campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'SEND' });
    recipientRepoMock.findOne = jest.fn().mockResolvedValue({ id: 'r1', campaignId: 'c1', status: RecipientStatus.FAILED });
    attemptRepoMock.findOne = jest.fn().mockResolvedValue({
      attemptNumber: 1,
      protocolNumber: 44919,
      protocolYear: 2026,
      protocolledAt: new Date('2026-07-14T09:16:25.603Z'),
      uploadedDocuments: null,
    });
    const valuesFn = jest.fn().mockReturnThis();
    const insertExec = jest.fn().mockResolvedValue({ raw: [{ id: 'attempt-2' }] });
    attemptRepoMock.createQueryBuilder.mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: valuesFn,
      returning: jest.fn().mockReturnThis(),
      execute: insertExec,
    });
    recipientRepoMock.update.mockResolvedValue({ affected: 1 });

    const moduleRef = await buildModule();
    const service = moduleRef.get(CampaignsService);

    await service.retryRecipient('c1', 'r1');

    const insertedValues = valuesFn.mock.calls[0][0];
    expect(insertedValues.uploadedDocuments).toBeUndefined();
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

describe('CampaignsService.getFailuresByReason', () => {
  it('raggruppa i destinatari falliti per errorMessage con conteggio decrescente', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getRepositoryToken(Campaign), useValue: {} },
        { provide: getRepositoryToken(Recipient), useValue: {} },
        { provide: getRepositoryToken(NotificationAttempt), useValue: {} },
        { provide: getRepositoryToken(DownloadEvent), useValue: {} },
        { provide: NotificationQueuesService, useValue: {} },
        { provide: AppSettingsService, useValue: { get: jest.fn(async () => null) } },
        { provide: ConfigService, useValue: { get: jest.fn(() => 'test-secret') } },
        { provide: InadService, useValue: { extractDigitalAddress: jest.fn(), startBulkExtraction: jest.fn() } },
      ],
    }).compile();
    const service = moduleRef.get(CampaignsService);

    jest.spyOn(service, 'getFailures').mockResolvedValue([
      { recipientId: 'r1', codiceFiscale: 'AAA1', fullName: 'A', errorMessage: 'timeout', attemptNumber: 1, lastAttemptAt: '2026-07-01T00:00:00.000Z' },
      { recipientId: 'r2', codiceFiscale: 'BBB2', fullName: 'B', errorMessage: 'timeout', attemptNumber: 1, lastAttemptAt: '2026-07-01T00:00:00.000Z' },
      { recipientId: 'r3', codiceFiscale: 'CCC3', fullName: 'C', errorMessage: 'CF non valido', attemptNumber: 1, lastAttemptAt: '2026-07-01T00:00:00.000Z' },
      { recipientId: 'r4', codiceFiscale: 'DDD4', fullName: 'D', errorMessage: null, attemptNumber: 0, lastAttemptAt: '2026-07-01T00:00:00.000Z' },
    ]);

    const result = await service.getFailuresByReason('c1');

    expect(result).toEqual([
      { errorMessage: 'timeout', count: 2, recipientIds: ['r1', 'r2'] },
      { errorMessage: 'CF non valido', count: 1, recipientIds: ['r3'] },
      { errorMessage: 'Errore sconosciuto', count: 1, recipientIds: ['r4'] },
    ]);
  });
});

describe('CampaignsService.retryRecipientsBulk', () => {
  it('ritenta ogni destinatario e conta successi/fallimenti separatamente', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getRepositoryToken(Campaign), useValue: {} },
        { provide: getRepositoryToken(Recipient), useValue: {} },
        { provide: getRepositoryToken(NotificationAttempt), useValue: {} },
        { provide: getRepositoryToken(DownloadEvent), useValue: {} },
        { provide: NotificationQueuesService, useValue: {} },
        { provide: AppSettingsService, useValue: { get: jest.fn(async () => null) } },
        { provide: ConfigService, useValue: { get: jest.fn(() => 'test-secret') } },
        { provide: InadService, useValue: { extractDigitalAddress: jest.fn(), startBulkExtraction: jest.fn() } },
      ],
    }).compile();
    const service = moduleRef.get(CampaignsService);

    jest
      .spyOn(service, 'retryRecipient')
      .mockResolvedValueOnce({ requeued: true, attemptId: 'a1' })
      .mockRejectedValueOnce(new Error('Solo i destinatari in stato FAILED possono essere rimessi in coda'))
      .mockResolvedValueOnce({ requeued: true, attemptId: 'a3' });

    const result = await service.retryRecipientsBulk('c1', ['r1', 'r2', 'r3']);

    expect(result).toEqual({
      requeued: 2,
      failed: [{ recipientId: 'r2', reason: 'Solo i destinatari in stato FAILED possono essere rimessi in coda' }],
    });
  });

  it('rifiuta più di 500 recipientIds senza chiamare retryRecipient', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getRepositoryToken(Campaign), useValue: {} },
        { provide: getRepositoryToken(Recipient), useValue: {} },
        { provide: getRepositoryToken(NotificationAttempt), useValue: {} },
        { provide: getRepositoryToken(DownloadEvent), useValue: {} },
        { provide: NotificationQueuesService, useValue: {} },
        { provide: AppSettingsService, useValue: { get: jest.fn(async () => null) } },
        { provide: ConfigService, useValue: { get: jest.fn(() => 'test-secret') } },
        { provide: InadService, useValue: { extractDigitalAddress: jest.fn(), startBulkExtraction: jest.fn() } },
      ],
    }).compile();
    const service = moduleRef.get(CampaignsService);
    const retrySpy = jest.spyOn(service, 'retryRecipient').mockResolvedValue({ requeued: true, attemptId: 'a1' });

    const tooMany = Array.from({ length: 501 }, (_, i) => `r${i}`);

    await expect(service.retryRecipientsBulk('c1', tooMany)).rejects.toThrow(BadRequestException);
    expect(retrySpy).not.toHaveBeenCalled();
  });
});

describe('CampaignsService.getDownloadReportRows', () => {
  it('mappa i destinatari della campagna nel formato report', async () => {
    const recipientRepoMock = { find: jest.fn() };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getRepositoryToken(Campaign), useValue: {} },
        { provide: getRepositoryToken(Recipient), useValue: recipientRepoMock },
        { provide: getRepositoryToken(NotificationAttempt), useValue: {} },
        { provide: getRepositoryToken(DownloadEvent), useValue: {} },
        { provide: NotificationQueuesService, useValue: {} },
        { provide: AppSettingsService, useValue: { get: jest.fn(async () => null) } },
        { provide: ConfigService, useValue: { get: jest.fn(() => 'test-secret') } },
        { provide: InadService, useValue: { extractDigitalAddress: jest.fn(), startBulkExtraction: jest.fn() } },
      ],
    }).compile();
    const service = moduleRef.get(CampaignsService);

    recipientRepoMock.find = jest.fn().mockResolvedValueOnce([
      {
        codiceFiscale: 'AAA1',
        fullName: 'Mario Rossi',
        email: 'mario@example.com',
        pec: null,
        status: RecipientStatus.SENT,
        downloadCount: 1,
        lastDownloadedAt: new Date('2026-07-01T10:00:00Z'),
      },
    ]);

    const result = await service.getDownloadReportRows('c1');

    expect(recipientRepoMock.find).toHaveBeenCalledWith({
      where: { campaignId: 'c1' },
      select: ['codiceFiscale', 'fullName', 'email', 'pec', 'status', 'downloadCount', 'lastDownloadedAt'],
      order: { createdAt: 'ASC' },
    });
    expect(result).toEqual([
      {
        codiceFiscale: 'AAA1',
        fullName: 'Mario Rossi',
        email: 'mario@example.com',
        pec: null,
        status: 'sent',
        downloadCount: 1,
        lastDownloadedAt: '2026-07-01T10:00:00.000Z',
      },
    ]);
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
        { provide: InadService, useValue: { extractDigitalAddress: jest.fn(), startBulkExtraction: jest.fn() } },
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
        { provide: InadService, useValue: { extractDigitalAddress: jest.fn(), startBulkExtraction: jest.fn() } },
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

describe('CampaignsService.getSendStatusBreakdown / getSendReportRows', () => {
  const campaignRepoMock = { findOneBy: jest.fn() };
  const recipientRepoMock = { find: jest.fn() };
  const attemptRepoMock = { find: jest.fn() };

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
        { provide: NotificationQueuesService, useValue: {} },
        { provide: AppSettingsService, useValue: { get: jest.fn(async () => null) } },
        { provide: ConfigService, useValue: { get: jest.fn(() => 'test-secret') } },
        { provide: InadService, useValue: { extractDigitalAddress: jest.fn(), startBulkExtraction: jest.fn() } },
      ],
    }).compile();

  describe('getSendStatusBreakdown', () => {
    it('conta i destinatari per ultimo sendStatus rilevato, un solo conteggio per destinatario', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'SEND' });
      recipientRepoMock.find.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
      attemptRepoMock.find.mockResolvedValue([
        { recipientId: 'r1', attemptNumber: 1, sendStatus: 'ACCEPTED' },
        { recipientId: 'r1', attemptNumber: 2, sendStatus: 'DELIVERED' },
        { recipientId: 'r2', attemptNumber: 1, sendStatus: 'DELIVERED' },
      ]);

      const moduleRef = await buildModule();
      const service = moduleRef.get(CampaignsService);

      const result = await service.getSendStatusBreakdown('c1');

      expect(result).toEqual(expect.arrayContaining([{ status: 'DELIVERED', count: 2 }]));
      expect(result).toHaveLength(1);
    });

    it('conta un attempt FAILED (mai arrivato al provider, sendStatus null) come \'FAILED\', non null', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'SEND' });
      recipientRepoMock.find.mockResolvedValue([{ id: 'r1' }]);
      attemptRepoMock.find.mockResolvedValue([
        { recipientId: 'r1', attemptNumber: 1, sendStatus: null, status: AttemptStatus.FAILED },
      ]);

      const moduleRef = await buildModule();
      const service = moduleRef.get(CampaignsService);

      const result = await service.getSendStatusBreakdown('c1');

      expect(result).toEqual([{ status: 'FAILED', count: 1 }]);
    });

    it('lancia NotFoundException se la campagna non esiste', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue(null);

      const moduleRef = await buildModule();
      const service = moduleRef.get(CampaignsService);

      await expect(service.getSendStatusBreakdown('missing')).rejects.toThrow('Campaign missing not found');
    });
  });

  describe('getSendReportRows', () => {
    it('proietta IUN, domicilio digitale e storico dall\'ultimo attempt per destinatario', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'SEND', channelConfig: {} });
      recipientRepoMock.find.mockResolvedValue([{ id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'Mario Rossi' }]);
      attemptRepoMock.find.mockResolvedValue([
        {
          recipientId: 'r1', attemptNumber: 1, iun: 'IUN-1', sendStatus: 'DELIVERED',
          sendStatusHistory: [{ status: 'ACCEPTED', activeFrom: '2026-01-10T10:00:00Z' }],
          sendDigitalDomicile: { type: 'PEC', address: 'x@pec.it', source: 'PLATFORM' },
          responsePayload: {},
        },
      ]);

      const moduleRef = await buildModule();
      const service = moduleRef.get(CampaignsService);

      const result = await service.getSendReportRows('c1');

      expect(result.hasAppIoCoDelivery).toBe(false);
      expect(result.rows).toEqual([{
        codiceFiscale: 'RSSMRA80A01H501U',
        fullName: 'Mario Rossi',
        iun: 'IUN-1',
        digitalDomicileType: 'PEC',
        digitalDomicileAddress: 'x@pec.it',
        sendStatus: 'DELIVERED',
        sendStatusHistory: [{ status: 'ACCEPTED', activeFrom: '2026-01-10T10:00:00Z' }],
        appIoOutcome: null,
      }]);
    });

    it('include appIoOutcome solo se la campagna ha co-consegna App IO configurata', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'SEND', channelConfig: { secondaryChannels: [{ channel: 'APP_IO', mode: 'parallel' }] } });
      recipientRepoMock.find.mockResolvedValue([{ id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'Mario Rossi' }]);
      attemptRepoMock.find.mockResolvedValue([
        {
          recipientId: 'r1', attemptNumber: 1, iun: 'IUN-1', sendStatus: 'DELIVERED',
          sendStatusHistory: [], sendDigitalDomicile: null,
          responsePayload: { appIo: { success: true } },
        },
      ]);

      const moduleRef = await buildModule();
      const service = moduleRef.get(CampaignsService);

      const result = await service.getSendReportRows('c1');

      expect(result.hasAppIoCoDelivery).toBe(true);
      expect(result.rows[0].appIoOutcome).toEqual({ success: true, error: null });
    });

    it('riporta sendStatus \'FAILED\' per un attempt FAILED senza sendStatus mai assegnato', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'SEND', channelConfig: {} });
      recipientRepoMock.find.mockResolvedValue([{ id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'Mario Rossi' }]);
      attemptRepoMock.find.mockResolvedValue([
        {
          recipientId: 'r1', attemptNumber: 1, iun: null, sendStatus: null, status: AttemptStatus.FAILED,
          sendStatusHistory: [], sendDigitalDomicile: null, responsePayload: {},
        },
      ]);

      const moduleRef = await buildModule();
      const service = moduleRef.get(CampaignsService);

      const result = await service.getSendReportRows('c1');

      expect(result.rows[0].sendStatus).toBe('FAILED');
    });
  });
});

describe('CampaignsService.getPostalStatusBreakdown / getPostalReportRows', () => {
  const campaignRepoMock = { findOneBy: jest.fn() };
  const recipientRepoMock = { find: jest.fn() };
  const attemptRepoMock = { find: jest.fn() };

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
        { provide: NotificationQueuesService, useValue: {} },
        { provide: AppSettingsService, useValue: { get: jest.fn(async () => null) } },
        { provide: ConfigService, useValue: { get: jest.fn(() => 'test-secret') } },
        { provide: InadService, useValue: { extractDigitalAddress: jest.fn(), startBulkExtraction: jest.fn() } },
      ],
    }).compile();

  describe('getPostalStatusBreakdown', () => {
    it('conta i destinatari per ultimo postalStatus rilevato, un solo conteggio per destinatario', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL' });
      recipientRepoMock.find.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
      attemptRepoMock.find.mockResolvedValue([
        { recipientId: 'r1', attemptNumber: 1, postalStatus: 'Accettato' },
        { recipientId: 'r1', attemptNumber: 2, postalStatus: 'Consegnato' },
        { recipientId: 'r2', attemptNumber: 1, postalStatus: 'Consegnato' },
      ]);

      const moduleRef = await buildModule();
      const service = moduleRef.get(CampaignsService);

      const result = await service.getPostalStatusBreakdown('c1');

      expect(result).toEqual(expect.arrayContaining([{ status: 'Consegnato', count: 2 }]));
      expect(result).toHaveLength(1);
    });

    it('conta un attempt FAILED (mai arrivato al provider, postalStatus null) come \'FAILED\', non null', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL' });
      recipientRepoMock.find.mockResolvedValue([{ id: 'r1' }]);
      attemptRepoMock.find.mockResolvedValue([
        { recipientId: 'r1', attemptNumber: 1, postalStatus: null, status: AttemptStatus.FAILED },
      ]);

      const moduleRef = await buildModule();
      const service = moduleRef.get(CampaignsService);

      const result = await service.getPostalStatusBreakdown('c1');

      expect(result).toEqual([{ status: 'FAILED', count: 1 }]);
    });

    it('lancia NotFoundException se la campagna non esiste', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue(null);

      const moduleRef = await buildModule();
      const service = moduleRef.get(CampaignsService);

      await expect(service.getPostalStatusBreakdown('missing')).rejects.toThrow('Campaign missing not found');
    });
  });

  describe('getPostalReportRows', () => {
    it('proietta IDPRO, storico ed errore dall\'ultimo attempt per destinatario', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL', channelConfig: {} });
      recipientRepoMock.find.mockResolvedValue([{ id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'Mario Rossi' }]);
      attemptRepoMock.find.mockResolvedValue([
        {
          recipientId: 'r1', attemptNumber: 1, postalTrackingId: 'IDPRO1', postalStatus: 'Consegnato',
          postalStatusHistory: [{ stato: 'Accettato', rilevatoIl: '2026-01-10T10:00:00.000Z' }],
          responsePayload: { codiceErrore: '', descrizione: '' },
        },
      ]);

      const moduleRef = await buildModule();
      const service = moduleRef.get(CampaignsService);

      const result = await service.getPostalReportRows('c1');

      expect(result.hasAppIoCoDelivery).toBe(false);
      expect(result.rows).toEqual([{
        codiceFiscale: 'RSSMRA80A01H501U',
        fullName: 'Mario Rossi',
        postalTrackingId: 'IDPRO1',
        postalStatus: 'Consegnato',
        postalStatusHistory: [{ stato: 'Accettato', rilevatoIl: '2026-01-10T10:00:00.000Z' }],
        codiceErrore: '',
        descrizioneErrore: '',
        appIoOutcome: null,
      }]);
    });

    it('include appIoOutcome solo se la campagna ha co-consegna App IO configurata', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL', channelConfig: { secondaryChannels: [{ channel: 'APP_IO', mode: 'parallel' }] } });
      recipientRepoMock.find.mockResolvedValue([{ id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'Mario Rossi' }]);
      attemptRepoMock.find.mockResolvedValue([
        {
          recipientId: 'r1', attemptNumber: 1, postalTrackingId: 'IDPRO1', postalStatus: 'Consegnato',
          postalStatusHistory: [], responsePayload: { appIo: { success: true } },
        },
      ]);

      const moduleRef = await buildModule();
      const service = moduleRef.get(CampaignsService);

      const result = await service.getPostalReportRows('c1');

      expect(result.hasAppIoCoDelivery).toBe(true);
      expect(result.rows[0].appIoOutcome).toEqual({ success: true, error: null });
    });

    it('riporta postalStatus \'FAILED\' per un attempt FAILED senza postalStatus mai assegnato', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL', channelConfig: {} });
      recipientRepoMock.find.mockResolvedValue([{ id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'Mario Rossi' }]);
      attemptRepoMock.find.mockResolvedValue([
        {
          recipientId: 'r1', attemptNumber: 1, postalTrackingId: null, postalStatus: null, status: AttemptStatus.FAILED,
          postalStatusHistory: [], responsePayload: {},
        },
      ]);

      const moduleRef = await buildModule();
      const service = moduleRef.get(CampaignsService);

      const result = await service.getPostalReportRows('c1');

      expect(result.rows[0].postalStatus).toBe('FAILED');
    });
  });
});

