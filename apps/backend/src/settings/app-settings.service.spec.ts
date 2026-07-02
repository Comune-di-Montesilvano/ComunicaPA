import { BadRequestException } from '@nestjs/common';
import { AppSettingsService } from './app-settings.service';
import { AppSetting } from '../entities/app-setting.entity';
import { MASKED_VALUE } from './settings.registry';
import { deriveSettingsKey, encryptValue } from './settings-crypto';

describe('AppSettingsService', () => {
  let rows: Map<string, AppSetting>;
  let service: AppSettingsService;

  const repoMock = {
    findOneBy: jest.fn(async ({ key }: { key: string }) => rows.get(key) ?? null),
    find: jest.fn(async () => Array.from(rows.values())),
    save: jest.fn(async (entity: AppSetting) => {
      rows.set(entity.key, entity);
      return entity;
    }),
  };

  const configMock = {
    get: jest.fn(() => 'test-jwt-secret'),
  };

  beforeEach(() => {
    rows = new Map();
    jest.clearAllMocks();
    delete process.env['SMTP_HOST'];
    delete process.env['RETENTION_MAX_DAYS'];
    delete process.env['SMTP_PASSWORD'];
    service = new AppSettingsService(repoMock as never, configMock as never);
  });

  it('legge dal DB quando la chiave esiste', async () => {
    rows.set('smtp.host', { key: 'smtp.host', value: 'mail.example.it', encrypted: false } as AppSetting);
    await expect(service.get('smtp.host')).resolves.toBe('mail.example.it');
  });

  it('fallback su env quando assente in DB, con coercizione di tipo', async () => {
    process.env['RETENTION_MAX_DAYS'] = '30';
    await expect(service.get('retention.maxDays')).resolves.toBe(30);
  });

  it('fallback sul default quando assente in DB e env', async () => {
    await expect(service.get('retention.maxDays')).resolves.toBe(90);
    await expect(service.get('smtp.host')).resolves.toBe('localhost');
  });

  it('usa la cache: seconda lettura senza query', async () => {
    rows.set('smtp.host', { key: 'smtp.host', value: 'mail.example.it', encrypted: false } as AppSetting);
    await service.get('smtp.host');
    await service.get('smtp.host');
    expect(repoMock.findOneBy).toHaveBeenCalledTimes(1);
  });

  it('decifra i valori cifrati', async () => {
    const key = deriveSettingsKey('test-jwt-secret');
    rows.set('smtp.password', {
      key: 'smtp.password',
      value: encryptValue('super-segreta', key),
      encrypted: true,
    } as AppSetting);
    await expect(service.get('smtp.password')).resolves.toBe('super-segreta');
  });

  it('decrypt fallito → fallback env/default senza lanciare', async () => {
    const wrongKey = deriveSettingsKey('altro-secret');
    rows.set('smtp.password', {
      key: 'smtp.password',
      value: encryptValue('x', wrongKey),
      encrypted: true,
    } as AppSetting);
    await expect(service.get('smtp.password')).resolves.toBe('');
  });

  it('setMany cifra i secret e invalida la cache', async () => {
    await service.get('smtp.host'); // popola cache col default
    await service.setMany({ 'smtp.host': 'nuovo.host.it', 'smtp.password': 'pwd123' }, 'mario.rossi');
    const saved = rows.get('smtp.password');
    expect(saved?.encrypted).toBe(true);
    expect(String(saved?.value).startsWith('enc:v1:')).toBe(true);
    await expect(service.get('smtp.host')).resolves.toBe('nuovo.host.it');
    await expect(service.get('smtp.password')).resolves.toBe('pwd123');
  });

  it('setMany ignora i secret mascherati (valore ••••••••)', async () => {
    await service.setMany({ 'smtp.password': 'originale' }, 'mario.rossi');
    await service.setMany({ 'smtp.password': MASKED_VALUE }, 'mario.rossi');
    await expect(service.get('smtp.password')).resolves.toBe('originale');
  });

  it('setMany rifiuta chiavi sconosciute con 400', async () => {
    await expect(service.setMany({ 'hack.me': 'x' }, 'u')).rejects.toThrow(BadRequestException);
  });

  it('setMany rifiuta tipi errati con 400', async () => {
    await expect(service.setMany({ 'retention.maxDays': 'trenta' }, 'u')).rejects.toThrow(BadRequestException);
  });

  it('getAllMasked maschera i secret valorizzati e lascia vuoti quelli assenti', async () => {
    await service.setMany({ 'smtp.password': 'pwd', 'smtp.host': 'h' }, 'u');
    const all = await service.getAllMasked();
    expect(all['smtp.password']).toBe(MASKED_VALUE);
    expect(all['pec.password']).toBe('');
    expect(all['smtp.host']).toBe('h');
    expect(all['retention.maxDays']).toBe(90);
  });
});
