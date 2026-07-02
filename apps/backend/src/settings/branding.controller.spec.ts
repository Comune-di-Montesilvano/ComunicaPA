import { BadRequestException, NotFoundException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BrandingController, ALLOWED_LOGO_TYPES } from './branding.controller';

describe('BrandingController', () => {
  const values = new Map<string, string | number | boolean>([
    ['brand.name', 'Comune Test'],
    ['brand.subtitle', ''],
    ['brand.logo', ''],
    ['brand.favicon', ''],
  ]);
  const settingsMock = {
    get: jest.fn(async (k: string) => values.get(k)),
    setMany: jest.fn(async (entries: Record<string, string>) => {
      for (const [k, v] of Object.entries(entries)) values.set(k, v);
    }),
  };
  const controller = new BrandingController(settingsMock as never);

  it('GET /branding senza logo → logoUrl null', async () => {
    const res = await controller.getBranding();
    expect(res).toEqual({ name: 'Comune Test', subtitle: '', logoUrl: null, faviconUrl: null });
  });

  it('GET /branding con logo → URL relativo', async () => {
    values.set('brand.logo', 'logo.png');
    const res = await controller.getBranding();
    expect(res.logoUrl).toBe('/branding/logo');
  });

  it('GET /branding/logo senza file configurato → 404', async () => {
    values.set('brand.logo', '');
    await expect(controller.getLogo({ sendFile: jest.fn() } as never)).rejects.toThrow(NotFoundException);
  });

  it('upload rifiuta mimetype non ammessi', async () => {
    const file = { mimetype: 'application/pdf', originalname: 'x.pdf', buffer: Buffer.from('') };
    await expect(controller.uploadLogo(file as never)).rejects.toThrow(BadRequestException);
  });

  it('espone i mimetype ammessi per il logo', () => {
    expect(ALLOWED_LOGO_TYPES).toContain('image/png');
    expect(ALLOWED_LOGO_TYPES).toContain('image/svg+xml');
  });

  it('upload senza estensione nel filename → fallback estensione dal mimetype', async () => {
    // Directory temporanea per non scrivere nello storage reale
    const tempRoot = mkdtempSync(join(tmpdir(), 'branding-test-'));
    const originalEnv = process.env['ATTACHMENTS_PATH'];
    process.env['ATTACHMENTS_PATH'] = tempRoot;
    try {
      const file = { mimetype: 'image/svg+xml', originalname: 'x', buffer: Buffer.from('<svg/>') };
      const res = await controller.uploadLogo(file as never);
      expect(res.filename).toBe('logo.svg');
    } finally {
      if (originalEnv === undefined) {
        delete process.env['ATTACHMENTS_PATH'];
      } else {
        process.env['ATTACHMENTS_PATH'] = originalEnv;
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
