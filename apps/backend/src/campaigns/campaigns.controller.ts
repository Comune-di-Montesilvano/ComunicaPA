import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import * as fs from 'fs';
import type { Request, Response } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import type { Campaign } from '../entities/campaign.entity';
import { Roles } from '../auth/decorators/roles.decorator';
import { CampaignsService } from './campaigns.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { PreviewMessageDto } from './dto/preview-message.dto';
import { getUploadsDir } from '../attachments/attachment-paths';
import { buildNeverDownloadedCsv } from './never-downloaded-csv.util';
import {
  assembleChunkedUpload,
  chunkUploadDir,
  cleanupChunkedUpload,
  initChunkedUpload,
  MAX_CHUNK_SIZE_BYTES,
} from './chunked-upload.util';

@Controller('admin/campaigns')
@Roles('user', 'admin')
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Get()
  findAll(): Promise<Campaign[]> {
    return this.campaignsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<Campaign> {
    return this.campaignsService.findOne(id);
  }

  @Post()
  create(
    @Body() dto: CreateCampaignDto,
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<Campaign> {
    return this.campaignsService.create(dto, req.user.username);
  }

  @Patch(':id')
  updateDraft(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCampaignDto) {
    return this.campaignsService.updateDraft(id, dto);
  }

  @Post('preview')
  previewMessage(@Body() dto: PreviewMessageDto) {
    return this.campaignsService.previewMessage(dto);
  }

  @Post(':id/recipients/upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: '/tmp/comunicapa-uploads',
        filename: (_req, file, cb) => {
          cb(null, `${Date.now()}${extname(file.originalname)}`);
        },
      }),
      fileFilter: (_req, file, cb) => {
        const ok = file.mimetype === 'text/csv' || file.originalname.endsWith('.csv');
        cb(null, ok);
      },
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  uploadCsv(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<{ imported: number; campaignId: string; blocked?: boolean; message?: string }> {
    if (!file) {
      throw new BadRequestException('File CSV richiesto (Content-Type: text/csv)');
    }
    return this.campaignsService.uploadCsv(id, file.path);
  }

  // ── Upload CSV destinatari a chunk ──────────────────────────────────────
  // Un reverse proxy esterno davanti al backend in produzione ha un limite di
  // dimensione del body che spezza l'upload in un'unica richiesta per CSV di
  // migliaia di destinatari. Il browser spezza il file in chunk più piccoli,
  // caricati uno alla volta e riassemblati qui prima di riusare uploadCsv.

  @Post(':id/recipients/upload/init')
  initRecipientsChunkedUpload(
    @Body() body: { filename?: string; totalChunks?: number },
  ): { uploadId: string } {
    const filename = body.filename?.trim();
    const totalChunks = Number(body.totalChunks);
    if (!filename || !Number.isInteger(totalChunks) || totalChunks < 1) {
      throw new BadRequestException('filename e totalChunks (intero >= 1) richiesti');
    }
    return { uploadId: initChunkedUpload(filename, totalChunks) };
  }

  @Post(':id/recipients/upload/chunk/:uploadId/:index')
  @UseInterceptors(
    FileInterceptor('chunk', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = chunkUploadDir(req.params['uploadId'] as string);
          if (!fs.existsSync(dir)) {
            cb(new BadRequestException('Sessione di upload non trovata o scaduta'), '');
            return;
          }
          cb(null, dir);
        },
        filename: (req, _file, cb) => {
          cb(null, `${req.params['index']}.part`);
        },
      }),
      limits: { fileSize: MAX_CHUNK_SIZE_BYTES },
    }),
  )
  uploadRecipientsChunk(): { ok: true } {
    return { ok: true };
  }

  @Post(':id/recipients/upload/complete/:uploadId')
  async completeRecipientsChunkedUpload(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('uploadId') uploadId: string,
  ): Promise<{ imported: number; campaignId: string; blocked?: boolean; message?: string }> {
    try {
      const { path } = await assembleChunkedUpload(uploadId);
      return await this.campaignsService.uploadCsv(id, path);
    } catch (err: any) {
      return { imported: 0, campaignId: id, blocked: true, message: err?.message ?? 'Errore durante il riassemblaggio dei chunk' };
    } finally {
      cleanupChunkedUpload(uploadId);
    }
  }

  @Post(':id/attachments')
  @UseInterceptors(
    FilesInterceptor('files', 1000, {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = getUploadsDir(req.params['id'] as string);
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          cb(null, file.originalname);
        },
      }),
      fileFilter: (_req, file, cb) => {
        const name = file.originalname.toLowerCase();
        const ok =
          file.mimetype === 'application/pdf' || name.endsWith('.pdf') ||
          file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed' || name.endsWith('.zip');
        cb(null, ok);
      },
    }),
  )
  async uploadAttachments(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    // FilesInterceptor + diskStorage scrivono i file su disco PRIMA che questo handler venga
    // eseguito. Se la campagna non è in DRAFT il file (potenzialmente sovrascritto) è già a
    // terra: eliminiamo gli upload appena scritti prima di rilanciare, così una richiesta
    // rifiutata non lascia file orfani/mutati (garanzia di immutabilità post-launch).
    try {
      await this.campaignsService.assertDraftForAttachments(id);
    } catch (err) {
      await Promise.all(
        (files ?? []).map((file) => fs.promises.unlink(file.path).catch(() => undefined)),
      );
      throw err;
    }
    const result = await this.campaignsService.finalizeAttachments(id, files ?? []);
    return {
      uploaded: result.uploaded,
      discarded: result.discarded,
      campaignId: id,
    };
  }

  // ── Upload allegati (ZIP/PDF) a chunk ───────────────────────────────────
  // Stesso motivo dei chunk per il CSV destinatari: uno ZIP con migliaia di
  // PDF personalizzati supera facilmente il limite del reverse proxy esterno
  // in un'unica richiesta.

  @Post(':id/attachments/upload/init')
  initAttachmentsChunkedUpload(
    @Body() body: { filename?: string; totalChunks?: number },
  ): { uploadId: string } {
    const filename = body.filename?.trim();
    const totalChunks = Number(body.totalChunks);
    if (!filename || !Number.isInteger(totalChunks) || totalChunks < 1) {
      throw new BadRequestException('filename e totalChunks (intero >= 1) richiesti');
    }
    return { uploadId: initChunkedUpload(filename, totalChunks) };
  }

  @Post(':id/attachments/upload/chunk/:uploadId/:index')
  @UseInterceptors(
    FileInterceptor('chunk', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = chunkUploadDir(req.params['uploadId'] as string);
          if (!fs.existsSync(dir)) {
            cb(new BadRequestException('Sessione di upload non trovata o scaduta'), '');
            return;
          }
          cb(null, dir);
        },
        filename: (req, _file, cb) => {
          cb(null, `${req.params['index']}.part`);
        },
      }),
      limits: { fileSize: MAX_CHUNK_SIZE_BYTES },
    }),
  )
  uploadAttachmentsChunk(): { ok: true } {
    return { ok: true };
  }

  @Post(':id/attachments/upload/complete/:uploadId')
  async completeAttachmentsChunkedUpload(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('uploadId') uploadId: string,
  ): Promise<{ uploaded: number; discarded: number; campaignId: string; blocked?: boolean; message?: string }> {
    try {
      await this.campaignsService.assertDraftForAttachments(id);
      const { path, filename } = await assembleChunkedUpload(uploadId);

      let result: { uploaded: number; discarded: number };
      if (filename.toLowerCase().endsWith('.zip')) {
        const fakeFile = { path, originalname: filename } as Express.Multer.File;
        result = await this.campaignsService.finalizeAttachments(id, [fakeFile]);
      } else {
        const dir = getUploadsDir(id);
        fs.mkdirSync(dir, { recursive: true });
        fs.renameSync(path, join(dir, filename));
        result = await this.campaignsService.finalizeAttachments(id, []);
      }
      return { uploaded: result.uploaded, discarded: result.discarded, campaignId: id };
    } catch (err: any) {
      return {
        uploaded: 0,
        discarded: 0,
        campaignId: id,
        blocked: true,
        message: err?.message ?? 'Errore durante la finalizzazione degli allegati',
      };
    } finally {
      cleanupChunkedUpload(uploadId);
    }
  }

  @Post(':id/launch')
  launch(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ launched: number; campaignId: string }> {
    return this.campaignsService.launch(id);
  }

  @Post(':id/cancel')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ cancelled: number; campaignId: string }> {
    return this.campaignsService.cancel(id);
  }

  @Get(':id/duplicate-source')
  getDuplicateSource(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getDuplicateSource(id);
  }

  @Get(':id/stats')
  getStats(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getStats(id);
  }

  @Get(':id/channel-stats')
  getChannelBreakdown(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getChannelBreakdown(id).then((breakdown) => ({ campaignId: id, breakdown }));
  }

  @Get(':id/download-channel-stats')
  async getDownloadChannelStats(@Param('id', ParseUUIDPipe) id: string) {
    const byChannel = await this.campaignsService.getDownloadChannelStats(id);
    return { campaignId: id, byChannel };
  }

  @Get(':id/download-cross-channel-stats')
  async getDownloadCrossChannelStats(@Param('id', ParseUUIDPipe) id: string) {
    const stats = await this.campaignsService.getDownloadCrossChannelStats(id);
    return { campaignId: id, stats };
  }

  @Get('stats/global')
  getGlobalStats(
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.campaignsService.getGlobalStats(dateFrom, dateTo);
  }

  @Get('stats/global/never-downloaded.csv')
  async exportNeverDownloadedCsv(
    @Query('dateFrom') dateFrom: string | undefined,
    @Query('dateTo') dateTo: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const rows = await this.campaignsService.getNeverDownloadedRecipients(dateFrom, dateTo);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="mai_scaricato.csv"');
    res.send(buildNeverDownloadedCsv(rows));
  }

  @Get(':id/failures')
  getFailures(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getFailures(id);
  }

  @Post(':id/recipients/:recipientId/retry')
  retryRecipient(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('recipientId', ParseUUIDPipe) recipientId: string,
  ) {
    return this.campaignsService.retryRecipient(id, recipientId);
  }

  @Get(':id/stats/recipients')
  getRecipientStats(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const parsedPage = parseInt(page ?? '1', 10);
    const parsedPageSize = parseInt(pageSize ?? '50', 10);

    if (!Number.isInteger(parsedPage) || parsedPage < 1) {
      throw new BadRequestException('Il parametro page deve essere un numero intero maggiore o uguale a 1');
    }
    if (!Number.isInteger(parsedPageSize) || parsedPageSize < 1) {
      throw new BadRequestException('Il parametro pageSize deve essere un numero intero maggiore o uguale a 1');
    }

    return this.campaignsService.getRecipientStats(id, parsedPage, parsedPageSize);
  }

  @Delete(':id')
  @Roles('admin')
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<{ deleted: true }> {
    return this.campaignsService.remove(id);
  }
}
