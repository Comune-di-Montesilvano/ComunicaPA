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

  describe('verifyProfile', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('ritorna active: true e success: true se il profilo esiste ed è abilitato', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sender_allowed: true }),
      });
      global.fetch = fetchMock;

      jest.spyOn(service, 'resolveApiKey').mockResolvedValue({ apiKey: 'key', idService: 'svc' });

      const result = await service.verifyProfile('RSSMRA85M01H501Z');
      expect(result).toEqual({
        success: true,
        active: true,
        message: 'Iscritto ad App IO e messaggi abilitati',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/profiles/RSSMRA85M01H501Z'),
        expect.any(Object),
      );
    });

    it('ritorna active: false se il profilo risponde 404', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });
      global.fetch = fetchMock;

      jest.spyOn(service, 'resolveApiKey').mockResolvedValue({ apiKey: 'key', idService: 'svc' });

      const result = await service.verifyProfile('RSSMRA85M01H501Z');
      expect(result).toEqual({
        success: true,
        active: false,
        message: 'Cittadino non iscritto ad App IO o codice fiscale errato',
      });
    });

    it('ritorna active: true ma messaggio disabilitato se sender_allowed è false', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sender_allowed: false }),
      });
      global.fetch = fetchMock;

      jest.spyOn(service, 'resolveApiKey').mockResolvedValue({ apiKey: 'key', idService: 'svc' });

      const result = await service.verifyProfile('RSSMRA85M01H501Z');
      expect(result.active).toBe(true);
      expect(result.message).toContain('disabilitati');
    });

    it('con ioServiceId esplicito non trovato NON ripiega sul servizio predefinito', async () => {
      repoMock.findOneBy.mockResolvedValue(null);
      const resolveSpy = jest.spyOn(service, 'resolveApiKey');

      await expect(service.verifyProfile('RSSMRA85M01H501Z', 'id-inesistente')).rejects.toThrow(
        'Nessun servizio App IO configurato o abilitato come predefinito',
      );
      expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('con ioServiceId esplicito esistente usa la chiave di quel servizio', async () => {
      const created = await service.create({
        nome: 'TARI', idService: 'SVC-BULK', apiKeyPrimaria: 'chiave-bulk',
      } as any);
      repoMock.findOneBy.mockResolvedValue({
        id: created.id,
        idService: 'SVC-BULK',
        apiKeyPrimariaEnc: repoMock.create.mock.calls[repoMock.create.mock.calls.length - 1][0].apiKeyPrimariaEnc,
      });
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ sender_allowed: true }) });
      global.fetch = fetchMock;

      const result = await service.verifyProfile('RSSMRA85M01H501Z', created.id);

      expect(result.active).toBe(true);
      expect(repoMock.findOneBy).toHaveBeenCalledWith({ id: created.id });
    });
  });
});
