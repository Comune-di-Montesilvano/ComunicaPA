import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ExternalApiClientsService } from './external-api-clients.service';
import { ExternalApiClient } from '../entities/external-api-client.entity';

describe('ExternalApiClientsService', () => {
  let service: ExternalApiClientsService;
  let repo: { create: jest.Mock; save: jest.Mock; findOneBy: jest.Mock; find: jest.Mock; update: jest.Mock };

  beforeEach(async () => {
    repo = {
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => ({ id: 'id-1', createdAt: new Date(), lastUsedAt: null, ...x })),
      findOneBy: jest.fn(),
      find: jest.fn(),
      update: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [ExternalApiClientsService, { provide: getRepositoryToken(ExternalApiClient), useValue: repo }],
    }).compile();
    service = module.get(ExternalApiClientsService);
  });

  it('generateKey crea un client con hash SHA-256 e ritorna la key in chiaro una sola volta', async () => {
    const { client, apiKeyPlain } = await service.generateKey('Comune X');
    expect(apiKeyPlain).toHaveLength(43); // 32 byte base64url senza padding
    expect(client.name).toBe('Comune X');
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    );
  });

  it('findActiveByKey trova il client dal hash della key in chiaro', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'id-1', active: true });
    const found = await service.findActiveByKey('una-key-qualsiasi');
    expect(repo.findOneBy).toHaveBeenCalledWith({ apiKeyHash: expect.any(String), active: true });
    expect(found).toEqual({ id: 'id-1', active: true });
  });

  it('findActiveByKey ritorna null se nessun client attivo corrisponde', async () => {
    repo.findOneBy.mockResolvedValue(null);
    expect(await service.findActiveByKey('key-sbagliata')).toBeNull();
  });
});
