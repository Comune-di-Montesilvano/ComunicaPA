import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { TemplatesService } from './templates.service';
import { Template } from '../entities/template.entity';

describe('TemplatesService', () => {
  const repoMock = {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: 'gen-id', createdAt: new Date(), updatedAt: new Date(), ...x })),
    find: jest.fn(),
    findOneBy: jest.fn(),
  };

  let service: TemplatesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [TemplatesService, { provide: getRepositoryToken(Template), useValue: repoMock }],
    }).compile();
    service = moduleRef.get(TemplatesService);
  });

  it('rifiuta un template MAIL senza bodyHtml', async () => {
    await expect(service.create({ type: 'MAIL', name: 'X', subject: 'Y', bodyHtml: '' } as any))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rifiuta un template APP_IO senza bodyMarkdown', async () => {
    await expect(service.create({ type: 'APP_IO', name: 'X', subject: 'Y', bodyMarkdown: '' } as any))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('crea un template MAIL valido', async () => {
    const result = await service.create({ type: 'MAIL', name: 'Avviso TARI', subject: 'Scadenza', bodyHtml: '<p>Corpo</p>' } as any);
    expect(result.type).toBe('MAIL');
    expect(result.bodyHtml).toBe('<p>Corpo</p>');
  });

  it('accoppia un template MAIL a un template APP_IO esistente', async () => {
    repoMock.findOneBy.mockResolvedValue({ id: 'io-1', type: 'APP_IO' });
    const result = await service.create({
      type: 'MAIL', name: 'Avviso TARI', subject: 'Scadenza', bodyHtml: '<p>Corpo</p>', pairedTemplateId: 'io-1',
    } as any);
    expect(result.pairedTemplateId).toBe('io-1');
  });

  it('rifiuta l accoppiamento se il template gemello non esiste', async () => {
    repoMock.findOneBy.mockResolvedValue(null);
    await expect(service.create({
      type: 'MAIL', name: 'X', subject: 'Y', bodyHtml: '<p>Z</p>', pairedTemplateId: 'missing',
    } as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rifiuta l accoppiamento tra due template dello stesso tipo (MAIL con MAIL)', async () => {
    repoMock.findOneBy.mockResolvedValue({ id: 'mail-2', type: 'MAIL' });
    await expect(service.create({
      type: 'MAIL', name: 'X', subject: 'Y', bodyHtml: '<p>Z</p>', pairedTemplateId: 'mail-2',
    } as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rifiuta l accoppiamento tra due template dello stesso tipo (APP_IO con APP_IO)', async () => {
    repoMock.findOneBy.mockResolvedValue({ id: 'io-2', type: 'APP_IO' });
    await expect(service.create({
      type: 'APP_IO', name: 'X', subject: 'Y', bodyMarkdown: 'Z', pairedTemplateId: 'io-2',
    } as any)).rejects.toBeInstanceOf(BadRequestException);
  });
});
