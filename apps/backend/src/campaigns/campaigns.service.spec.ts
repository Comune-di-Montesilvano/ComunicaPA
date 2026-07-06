import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CampaignsService } from './campaigns.service';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { NotificationQueuesService } from '../queue/notification-queues.service';
import { AppSettingsService } from '../settings/app-settings.service';
import * as fs from 'fs';
import { join } from 'path';
import * as os from 'os';
import AdmZip from 'adm-zip';

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
  };
  const mockRecipientRepo = {
    find: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    findAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  const mockAttemptRepo = {
    createQueryBuilder: jest.fn().mockReturnValue({
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [] }),
    }),
  };
  const mockQueue = { addBulk: jest.fn().mockResolvedValue(undefined) };
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
    mockCampaignQb.execute.mockResolvedValue({ affected: 1 });
    mockCampaignRepo.createQueryBuilder.mockReturnValue(mockCampaignQb);
    mockRecipientRepo.find.mockResolvedValue([]);
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
      { name: 'send', data: { campaignId: 'c1', recipientId: 'r1', attemptId: 'attempt-2', channel: 'EMAIL' } },
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
  const recipientRepoMock = { find: jest.fn().mockResolvedValue([]) };
  const attemptRepoMock = { createQueryBuilder: jest.fn() };
  const queuesMock = { addBulk: jest.fn() };

  const buildModule = () =>
    Test.createTestingModule({
      providers: [
        CampaignsService,
        { provide: getRepositoryToken(Campaign), useValue: campaignRepoMock },
        { provide: getRepositoryToken(Recipient), useValue: recipientRepoMock },
        { provide: getRepositoryToken(NotificationAttempt), useValue: attemptRepoMock },
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
      subject: 'Avviso per %nominativo%',
      body: 'Gentile %nominativo%, scarica %allegato1%',
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
      body: 'Elenco: %elenco_allegati%',
      attachments: [{ key: 'file', label: 'Avviso TARI' }],
      recipient: { codiceFiscale: 'RSSMRA80A01H501U' },
      format: 'markdown',
    });

    expect(result.bodyMarkdown).toContain('- **Avviso TARI**');
    expect(result.bodyHtml).toBeUndefined();
  });
});

