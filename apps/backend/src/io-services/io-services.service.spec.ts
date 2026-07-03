import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { IoServicesService } from './io-services.service';
import { IoServiceConfig } from '../entities/io-service-config.entity';

describe('IoServicesService', () => {
  let service: IoServicesService;
  const repoMock = {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: 'gen-id', testedAt: null, isDefault: false, ...x })),
    find: jest.fn(),
    findOneBy: jest.fn(),
    update: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        IoServicesService,
        { provide: getRepositoryToken(IoServiceConfig), useValue: repoMock },
        { provide: ConfigService, useValue: { get: () => 'test-jwt-secret-min-32-chars-long!!' } },
      ],
    }).compile();
    service = moduleRef.get(IoServicesService);
  });

  it('cifra la api key primaria alla creazione e la maschera in output', async () => {
    const result = await service.create({
      nome: 'TARI', idService: 'SVC1', apiKeyPrimaria: 'segreto123', isDefault: true,
    } as any);

    expect(repoMock.save).toHaveBeenCalled();
    const savedArg = repoMock.create.mock.calls[0][0];
    expect(savedArg.apiKeyPrimariaEnc).not.toBe('segreto123');
    expect(savedArg.apiKeyPrimariaEnc).toMatch(/^enc:v1:/);
    expect(result.apiKeyPrimaria).toBe('••••••••');
  });

  it('resolveApiKey ritorna la chiave in chiaro del servizio richiesto', async () => {
    const encrypted = (await service.create({
      nome: 'TARI', idService: 'SVC1', apiKeyPrimaria: 'segreto123',
    } as any));
    repoMock.findOneBy.mockResolvedValue({
      id: encrypted.id,
      idService: 'SVC1',
      apiKeyPrimariaEnc: repoMock.create.mock.calls[0][0].apiKeyPrimariaEnc,
    });

    const resolved = await service.resolveApiKey(encrypted.id);

    expect(resolved).toEqual({ apiKey: 'segreto123', idService: 'SVC1' });
  });

  it('resolveApiKey senza id usa il servizio default', async () => {
    await service.create({
      nome: 'DEFAULT', idService: 'SVC-DEFAULT', apiKeyPrimaria: 'segreto456', isDefault: true,
    } as any);
    repoMock.find.mockResolvedValue([{
      id: 'def-id',
      idService: 'SVC-DEFAULT',
      apiKeyPrimariaEnc: repoMock.create.mock.calls[0][0].apiKeyPrimariaEnc,
      isDefault: true,
    }]);

    const resolved = await service.resolveApiKey(undefined);

    expect(repoMock.find).toHaveBeenCalledWith({ where: { isDefault: true } });
    expect(resolved?.idService).toBe('SVC-DEFAULT');
  });
});
