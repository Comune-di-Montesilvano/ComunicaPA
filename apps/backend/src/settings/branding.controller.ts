import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { getBrandingDir } from '../attachments/attachment-paths';
import { AppSettingsService } from './app-settings.service';

export const ALLOWED_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml'];
export const ALLOWED_FAVICON_TYPES = ['image/png', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'];
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB

// Estensione di fallback derivata dal mimetype validato (per originalname senza estensione)
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
};

@Controller()
export class BrandingController {
  constructor(private readonly appSettings: AppSettingsService) {}

  @Public()
  @Get('branding')
  async getBranding() {
    const [name, subtitle, logo, favicon] = await Promise.all([
      this.appSettings.get<string>('brand.name'),
      this.appSettings.get<string>('brand.subtitle'),
      this.appSettings.get<string>('brand.logo'),
      this.appSettings.get<string>('brand.favicon'),
    ]);
    // Il setting può contenere un filename locale (upload) oppure un URL esterno
    const resolve = (value: string, localPath: string): string | null =>
      value ? (/^https?:\/\//i.test(value) ? value : localPath) : null;
    return {
      name,
      subtitle,
      logoUrl: resolve(logo, '/branding/logo'),
      faviconUrl: resolve(favicon, '/branding/favicon'),
    };
  }

  @Public()
  @Get('branding/logo')
  async getLogo(@Res() res: Response): Promise<void> {
    await this.serveFile('brand.logo', res);
  }

  @Public()
  @Get('branding/favicon')
  async getFavicon(@Res() res: Response): Promise<void> {
    await this.serveFile('brand.favicon', res);
  }

  @Post('settings/branding/logo')
  @Roles('admin')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE } }))
  async uploadLogo(@UploadedFile() file: Express.Multer.File) {
    return this.saveBrandingFile(file, ALLOWED_LOGO_TYPES, 'logo', 'brand.logo');
  }

  @Post('settings/branding/favicon')
  @Roles('admin')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE } }))
  async uploadFavicon(@UploadedFile() file: Express.Multer.File) {
    return this.saveBrandingFile(file, ALLOWED_FAVICON_TYPES, 'favicon', 'brand.favicon');
  }

  private async serveFile(settingKey: 'brand.logo' | 'brand.favicon', res: Response): Promise<void> {
    const filename = await this.appSettings.get<string>(settingKey);
    // basename() neutralizza path traversal: il setting è scrivibile via PUT /settings
    // ma qui deve risolvere solo file dentro la directory di branding
    const safeName = filename ? basename(filename) : '';
    const filePath = safeName ? join(getBrandingDir(), safeName) : '';
    if (!safeName || safeName !== filename || !existsSync(filePath)) {
      throw new NotFoundException('File di branding non configurato');
    }
    res.sendFile(filePath);
  }

  private async saveBrandingFile(
    file: Express.Multer.File,
    allowedTypes: string[],
    baseName: 'logo' | 'favicon',
    settingKey: 'brand.logo' | 'brand.favicon',
  ): Promise<{ filename: string }> {
    if (!file) {
      throw new BadRequestException('File richiesto (campo multipart "file")');
    }
    if (!allowedTypes.includes(file.mimetype)) {
      throw new BadRequestException(`Tipo non ammesso: ${file.mimetype}. Ammessi: ${allowedTypes.join(', ')}`);
    }
    if (file.buffer.length > MAX_FILE_SIZE) {
      throw new BadRequestException('File troppo grande (max 2 MB)');
    }

    const dir = getBrandingDir();
    mkdirSync(dir, { recursive: true });

    // Rimuovi le versioni precedenti con estensione diversa (logo.png vs logo.svg)
    for (const existing of readdirSync(dir)) {
      if (existing.startsWith(`${baseName}.`)) {
        unlinkSync(join(dir, existing));
      }
    }

    const filename = `${baseName}${extname(file.originalname).toLowerCase() || (MIME_EXTENSIONS[file.mimetype] ?? '.png')}`;
    writeFileSync(join(dir, filename), file.buffer);
    await this.appSettings.setMany({ [settingKey]: filename }, 'branding-upload');
    return { filename };
  }
}
