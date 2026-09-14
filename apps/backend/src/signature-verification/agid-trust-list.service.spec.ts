import { vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as forge from 'node-forge';
import { AgidTrustListService } from './agid-trust-list.service.js';
import { AgidTrustListCache } from '../entities/agid-trust-list-cache.entity.js';

// Un piccolo certificato self-signed di test, generato al volo — mai CF/dati reali.
function makeTestCertPem(): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: 'Test CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey);
  return forge.pki.certificateToPem(cert);
}

describe('AgidTrustListService', () => {
  let service: AgidTrustListService;
  let repo: { findOne: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };
  const testCertPem = makeTestCertPem();

  beforeEach(async () => {
    repo = { findOne: vi.fn(), save: vi.fn((v) => Promise.resolve(v)) };
    global.fetch = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgidTrustListService,
        { provide: getRepositoryToken(AgidTrustListCache), useValue: repo },
      ],
    }).compile();

    service = module.get(AgidTrustListService);
  });

  describe('getTrustedCertificates', () => {
    it('ritorna la cache esistente senza fare fetch se già presente e recente', async () => {
      repo.findOne.mockResolvedValueOnce({
        id: 'x',
        certificatesPem: [testCertPem],
        fetchedAt: new Date(),
      });

      const result = await service.getTrustedCertificates();

      expect(result).toHaveLength(1);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('fa il refresh se la cache non esiste', async () => {
      repo.findOne.mockResolvedValueOnce(null);
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        text: async () => `<?xml version="1.0"?><TrustServiceStatusList></TrustServiceStatusList>`,
      });

      const result = await service.getTrustedCertificates();

      expect(global.fetch).toHaveBeenCalledWith('https://eidas.agid.gov.it/TL/TSL-IT.xml');
      expect(result).toEqual([]);
    });
  });

  describe('refresh', () => {
    it('se il fetch fallisce, mantiene la cache esistente (fail-open)', async () => {
      repo.findOne.mockResolvedValueOnce({
        id: 'x',
        certificatesPem: [testCertPem],
        fetchedAt: new Date('2020-01-01'),
      });
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('rete assente'));

      await service.refresh();

      expect(repo.save).not.toHaveBeenCalled();
    });
  });
});
