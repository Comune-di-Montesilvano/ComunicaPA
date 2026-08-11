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
  Put,
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
import { EnrichmentEventsService } from './enrichment-events.service';
import {
  MAX_CHUNK_SIZE_BYTES,
  assembleChunkedUpload,
  cleanupChunkedUpload,
  initChunkedUpload,
  isValidChunkIndex,
  safeChunkUploadDir,
} from '../campaigns/chunked-upload.util';
import { getEnrichmentResultCsv } from './enrichment-paths';

@Controller('admin/enrichment')
export class EnrichmentController {
  constructor(
    private readonly svc: EnrichmentService,
    private readonly events: EnrichmentEventsService,
  ) {}

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
          // safeChunkUploadDir() mai un throw: dentro un callback diskStorage
          // sincrono un throw grezzo sfugge come uncaughtException e abbatte
          // l'intero processo Node (nessun handler globale in questo repo —
          // bug reale, review fix path-traversal external-api chunk()/complete()).
          const dir = safeChunkUploadDir(req.params['uploadId']);
          if (!dir || !fs.existsSync(dir)) {
            cb(new BadRequestException('Sessione di upload non trovata o scaduta'), '');
            return;
          }
          cb(null, dir);
        },
        filename: (req, _file, cb) => {
          const index = req.params['index'];
          if (!isValidChunkIndex(index)) {
            cb(new BadRequestException('index non valido'), '');
            return;
          }
          cb(null, `${index}.part`);
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
    @Body() body: { traceFormat?: TraceFormat; searchPayments?: boolean },
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
        searchPayments: body.searchPayments ?? true,
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

  @Get('jobs/:id/stream')
  @Roles('user', 'admin')
  async streamJob(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const job = await this.svc.getJob(id);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (job.status === 'done' || job.status === 'failed') {
      res.write(`data: ${JSON.stringify({ type: job.status === 'done' ? 'done' : 'error', message: job.errorMessage ?? undefined })}\n\n`);
      res.end();
      return;
    }

    await new Promise<void>((resolve) => {
      const unsubscribe = this.events.subscribe(id, (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'done' || event.type === 'error') {
          unsubscribe();
          res.end();
          resolve();
        }
      });
      req.on('close', () => {
        unsubscribe();
        resolve();
      });
    });
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
    return this.svc.requestCampaignConversion(id, { name, channelType: body.channelType }, req.user.username);
  }

  @Get('jobs/:id/overrides')
  @Roles('user', 'admin')
  getCorrectedPdfs(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getCorrectedPdfs(id).then((pdfs) => ({ pdfs }));
  }

  @Get('jobs/:id/rows/:pdfFilename')
  @Roles('user', 'admin')
  getRow(@Param('id', ParseUUIDPipe) id: string, @Param('pdfFilename') pdfFilename: string) {
    return this.svc.getRow(id, pdfFilename);
  }

  @Put('jobs/:id/rows/:pdfFilename')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  saveRowOverride(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('pdfFilename') pdfFilename: string,
    @Body() body: Record<string, string>,
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    return this.svc.saveRowOverride(id, pdfFilename, body, req.user.username);
  }

  @Post('jobs/:id/regenerate-csv')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  regenerateCsv(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.regenerateCsv(id);
  }
}
