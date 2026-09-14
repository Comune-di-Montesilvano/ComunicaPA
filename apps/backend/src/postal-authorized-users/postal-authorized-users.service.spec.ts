import { vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PostalAuthorizedUsersService } from './postal-authorized-users.service.js';
import { PostalAuthorizedUser } from '../entities/postal-authorized-user.entity.js';
import { OperatorDirectoryService } from '../operator-directory/operator-directory.service.js';

describe('PostalAuthorizedUsersService', () => {
  let service: PostalAuthorizedUsersService;
  let repo: {
    find: ReturnType<typeof vi.fn>;
    existsBy: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let operatorDirectory: { resolveMany: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = {
      find: vi.fn(),
      existsBy: vi.fn(),
      create: vi.fn((v) => v),
      save: vi.fn((v) => Promise.resolve({ id: 'new-id', createdAt: new Date('2026-01-01'), ...v })),
      delete: vi.fn(),
    };
    operatorDirectory = { resolveMany: vi.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PostalAuthorizedUsersService,
        { provide: getRepositoryToken(PostalAuthorizedUser), useValue: repo },
        { provide: OperatorDirectoryService, useValue: operatorDirectory },
      ],
    }).compile();

    service = module.get(PostalAuthorizedUsersService);
  });

  describe('isAuthorized', () => {
    it('ritorna true se lo username esiste in tabella (case-insensitive)', async () => {
      repo.existsBy.mockResolvedValueOnce(true);
      const result = await service.isAuthorized('Mario.Rossi');
      expect(result).toBe(true);
      expect(repo.existsBy).toHaveBeenCalledWith({ username: 'mario.rossi' });
    });

    it('ritorna false se lo username non esiste', async () => {
      repo.existsBy.mockResolvedValueOnce(false);
      const result = await service.isAuthorized('sconosciuto');
      expect(result).toBe(false);
    });
  });

  describe('create', () => {
    it('rifiuta username vuoto', async () => {
      await expect(service.create('   ', 'admin1')).rejects.toThrow(BadRequestException);
    });

    it('rifiuta un duplicato', async () => {
      repo.existsBy.mockResolvedValueOnce(true);
      await expect(service.create('mario.rossi', 'admin1')).rejects.toThrow('Utente già abilitato');
    });

    it('normalizza e crea la riga', async () => {
      repo.existsBy.mockResolvedValueOnce(false);
      const result = await service.create('  Mario.Rossi  ', 'admin1');
      expect(repo.create).toHaveBeenCalledWith({ username: 'mario.rossi', addedBy: 'admin1' });
      expect(result.username).toBe('mario.rossi');
    });
  });

  describe('remove', () => {
    it('lancia NotFoundException se la riga non esiste', async () => {
      repo.delete.mockResolvedValueOnce({ affected: 0 });
      await expect(service.remove('no-id')).rejects.toThrow(NotFoundException);
    });

    it('elimina la riga esistente', async () => {
      repo.delete.mockResolvedValueOnce({ affected: 1 });
      await expect(service.remove('id-1')).resolves.toBeUndefined();
    });
  });

  describe('list', () => {
    it('risolve i display name via OperatorDirectoryService', async () => {
      repo.find.mockResolvedValueOnce([
        { id: '1', username: 'mario.rossi', addedBy: 'admin1', createdAt: new Date('2026-01-01') },
      ]);
      operatorDirectory.resolveMany.mockResolvedValueOnce({ admin1: 'Amministratore Uno' });

      const result = await service.list();

      expect(result).toEqual([
        {
          id: '1',
          username: 'mario.rossi',
          addedBy: 'admin1',
          addedByDisplayName: 'Amministratore Uno',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
    });
  });
});
