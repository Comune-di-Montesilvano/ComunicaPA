import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator';
import { TraceFormat } from '../entities/enrichment-job.entity';
import { EnrichmentService } from './enrichment.service';
import {
  MAX_CHUNK_SIZE_BYTES,
  assembleChunkedUpload,
  chunkUploadDir,
  cleanupChunkedUpload,
  initChunkedUpload,
} from '../campaigns/chunked-upload.util';
import { getEnrichmentResultCsv } from './enrichment-paths';

@Controller('admin/enrichment')
export class EnrichmentController {
  constructor(private readonly svc: EnrichmentService) {}

  // ── Upload ZIP SEMPRE a chunk (limite ~1MB reverse proxy esterno) ────────

  @Post('upload/init')
  @Roles('user', 'admin')
  initUpload(@Body() body: { filename?: string; totalChunks?: number }): { uploadId: string } {
    const filename = body.filename?.trim();
    const totalChunks = Number(body.totalChunks);
    if (!filename || !Number.isInteger(totalChunks) || totalChunks < 1) {
      throw new BadRequestException('filename e totalChunks (intero >= 1) richiesti');
    }
    return { uploadId: initChunkedUpload(filename, totalChunks) };
  }

  @Post('upload/chunk/:uploadId/:index')
  @Roles('user', 'admin')
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
  uploadChunk(): { ok: true } {
    return { ok: true };
  }

  @Post('upload/complete/:uploadId')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  async completeUpload(
    @Param('uploadId') uploadId: string,
    @Body() body: { traceFormat?: TraceFormat },
    @Req() req: Request & { user: JwtOperatorPayload },
  ): Promise<{ jobId?: string; blocked?: boolean; message?: string }> {
    try {
      if (!body.traceFormat || !Object.values(TraceFormat).includes(body.traceFormat)) {
        return { blocked: true, message: 'Formato tracciato non riconosciuto' };
      }
      const { path, filename } = await assembleChunkedUpload(uploadId);
      return await this.svc.createJob({
        zipPath: path,
        sourceFilename: filename,
        traceFormat: body.traceFormat,
        createdBy: req.user.username,
      });
    } catch (err: any) {
      return { blocked: true, message: err?.message ?? 'Errore durante il riassemblaggio dello ZIP' };
    } finally {
      cleanupChunkedUpload(uploadId);
    }
  }

  // ── Stato e risultati ────────────────────────────────────────────────────

  @Get('jobs')
  @Roles('user', 'admin')
  listJobs() {
    return this.svc.listJobs().then((jobs) => ({ jobs }));
  }

  @Get('jobs/:id')
  @Roles('user', 'admin')
  getJob(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getJob(id);
  }

  @Get('jobs/:id/result.csv')
  @Roles('user', 'admin')
  async downloadCsv(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    await this.svc.getJob(id);
    const path = getEnrichmentResultCsv(id);
    if (!fs.existsSync(path)) {
      // 200 + blocked, mai non-2xx: il proxy esterno sostituisce il body
      // delle risposte non-2xx con una pagina HTML propria (vedi CLAUDE.md).
      res.status(200).json({ blocked: true, message: 'Risultato non disponibile' });
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="arricchito_${id.slice(0, 8)}.csv"`);
    res.send(fs.readFileSync(path));
  }

  @Get('jobs/:id/result.zip')
  @Roles('user', 'admin')
  async downloadZip(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const buf = await this.svc.buildResultZip(id);
    if (!buf) {
      // 200 + blocked, mai non-2xx: il proxy esterno sostituisce il body
      // delle risposte non-2xx con una pagina HTML propria (vedi CLAUDE.md).
      res.status(200).json({ blocked: true, message: 'Risultato non disponibile' });
      return;
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="arricchito_${id.slice(0, 8)}.zip"`);
    res.send(buf);
  }

  @Delete('jobs/:id')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  deleteJob(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.deleteJob(id);
  }

  @Post('jobs/:id/create-campaign')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  createCampaign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { name?: string; channelType?: 'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL' },
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    const name = body.name?.trim();
    if (!name || !body.channelType) {
      return { blocked: true, message: 'Nome campagna e canale richiesti' };
    }
    return this.svc.createCampaignFromJob(id, { name, channelType: body.channelType }, req.user.username);
  }
}
