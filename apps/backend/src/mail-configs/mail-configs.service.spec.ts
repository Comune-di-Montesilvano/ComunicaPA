import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { MailConfigsService } from './mail-configs.service';
import { MailServerConfig } from '../entities/mail-server-config.entity';
import { AppSettingsService } from '../settings/app-settings.service';
import { MASKED_VALUE } from '../settings/settings.registry';

describe('MailConfigsService', () => {
  let service: MailConfigsService;
  const repo = {
    find: jest.fn(),
    findOneBy: jest.fn(),
    save: jest.fn((e) => Promise.resolve({ id: 'gen-id', ...e })),
    create: jest.fn((e) => e),
    delete: jest.fn(),
    count: jest.fn().mockResolvedValue(1),
  };
  const appSettings = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        MailConfigsService,
        { provide: getRepositoryToken(MailServerConfig), useValue: repo },
        { provide: AppSettingsService, useValue: appSettings },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test-jwt-secret-for-crypto') },
        },
      ],
    }).compile();
    service = module.get(MailConfigsService);
  });

  it('create cifra la password e ritorna il DTO mascherato', async () => {
    const dto = {
      type: 'EMAIL' as const, name: 'SMTP Comune', host: 'smtp.example.org',
      port: 587, secure: false, authEnabled: true,
      username: 'noreply', password: 'segreta',
      fromAddress: 'noreply@example.org', batchSize: 100, batchIntervalSeconds: 60,
    };
    const result = await service.create(dto);
    // la password salvata NON è in chiaro
    const saved = repo.save.mock.calls[0][0];
    expect(saved.passwordEnc).not.toBe('segreta');
    expect(saved.passwordEnc.length).toBeGreaterThan(0);
    // il DTO risposto è mascherato
    expect(result.password).toBe(MASKED_VALUE);
    expect(result.active).toBe(false);
    expect(result.testedAt).toBeNull();
  });

  it('update con password mascherata non tocca quella salvata', async () => {
    repo.findOneBy.mockResolvedValue({
      id: 'x', type: 'EMAIL', name: 'a', host: 'h', port: 587, secure: false,
      authEnabled: true, username: 'u', passwordEnc: 'ENC-ORIGINALE',
      fromAddress: 'a@b.c', batchSize: 100, batchIntervalSeconds: 60,
      testedAt: null, active: false,
    });
    await service.update('x', { password: MASKED_VALUE, name: 'nuovo' });
    const saved = repo.save.mock.calls[0][0];
    expect(saved.passwordEnc).toBe('ENC-ORIGINALE');
    expect(saved.name).toBe('nuovo');
  });

  it('update di host/port/credenziali invalida il test (testedAt=null, active=false)', async () => {
    repo.findOneBy.mockResolvedValue({
      id: 'x', type: 'EMAIL', name: 'a', host: 'h', port: 587, secure: false,
      authEnabled: true, username: 'u', passwordEnc: 'E',
      fromAddress: 'a@b.c', batchSize: 100, batchIntervalSeconds: 60,
      testedAt: new Date(), active: true,
    });
    await service.update('x', { host: 'nuovo-host' });
    const saved = repo.save.mock.calls[0][0];
    expect(saved.testedAt).toBeNull();
    expect(saved.active).toBe(false);
  });

  it('setActive(true) fallisce se mai testata', async () => {
    repo.findOneBy.mockResolvedValue({ id: 'x', testedAt: null, active: false });
    await expect(service.setActive('x', true)).rejects.toThrow(BadRequestException);
  });

  it('setActive(false) disattiva senza vincoli', async () => {
    repo.findOneBy.mockResolvedValue({
      id: 'x', type: 'EMAIL', name: 'a', host: 'h', port: 587, secure: false,
      authEnabled: true, username: '', passwordEnc: '', fromAddress: 'a@b.c',
      batchSize: 100, batchIntervalSeconds: 60, testedAt: new Date(), active: true,
    });
    const result = await service.setActive('x', false);
    expect(result.active).toBe(false);
  });

  it('resolveForSend usa la config indicata da mailConfigId', async () => {
    repo.findOneBy.mockResolvedValue({
      id: 'cfg1', type: 'EMAIL', name: 'a', host: 'smtp.x', port: 25, secure: false,
      authEnabled: false, username: '', passwordEnc: '', fromAddress: 'a@b.c',
      batchSize: 50, batchIntervalSeconds: 30, testedAt: new Date(), active: true,
    });
    const r = await service.resolveForSend('EMAIL', 'cfg1');
    expect(r.host).toBe('smtp.x');
    expect(r.authEnabled).toBe(false);
    expect(r.batchSize).toBe(50);
    expect(r.configId).toBe('cfg1');
  });

  it('resolveForSend senza id usa la prima config attiva del tipo', async () => {
    repo.findOneBy.mockResolvedValue(null);
    repo.find.mockResolvedValue([{
      id: 'cfg2', type: 'PEC', name: 'a', host: 'pec.x', port: 465, secure: true,
      authEnabled: true, username: 'u', passwordEnc: '', fromAddress: 'p@b.c',
      batchSize: 100, batchIntervalSeconds: 60, testedAt: new Date(), active: true,
    }]);
    const r = await service.resolveForSend('PEC');
    expect(r.host).toBe('pec.x');
    expect(r.configId).toBe('cfg2');
  });

  it('resolveForSend fallback legacy dai settings se nessuna config attiva', async () => {
    repo.findOneBy.mockResolvedValue(null);
    repo.find.mockResolvedValue([]);
    appSettings.get.mockImplementation((key: string) => {
      const map: Record<string, unknown> = {
        'smtp.host': 'legacy.smtp', 'smtp.port': 587, 'smtp.secure': false,
        'smtp.user': 'legacyuser', 'smtp.password': 'legacypass', 'smtp.from': 'legacy@x.it',
      };
      return Promise.resolve(map[key]);
    });
    const r = await service.resolveForSend('EMAIL');
    expect(r.host).toBe('legacy.smtp');
    expect(r.username).toBe('legacyuser');
    expect(r.authEnabled).toBe(true);
    expect(r.configId).toBeNull();
    expect(r.batchSize).toBe(100); // default throttling per legacy
  });
});
