import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Res, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { DomicileVerificationService, DomicileVerificationCsvVariant } from './domicile-verification.service.js';
import { VerifyDomicileBulkCompleteDto } from './dto/domicile-verification.dto.js';
import { initChunkedUpload, safeChunkUploadDir, isValidChunkIndex, assembleChunkedUpload, cleanupChunkedUpload, MAX_CHUNK_SIZE_BYTES } from '../../campaigns/chunked-upload.util.js';

const FILENAME_BY_VARIANT: Record<DomicileVerificationCsvVariant, string> = {
  'assenti': 'assenti',
  'app-io': 'app_io',
  'inad': 'inad',
  'registro-imprese': 'registro_imprese',
  'aggregato': 'aggregato',
};

@Controller('admin/domicile-verification')
export class DomicileVerificationController {
  constructor(private readonly svc: DomicileVerificationService) {}

  @Post('verify/upload/init')
  @Roles('user', 'admin')
  initUpload(@Body() body: { filename?: string; totalChunks?: number }): { uploadId: string } {
    const filename = body.filename?.trim();
    const totalChunks = Number(body.totalChunks);
    if (!filename || !Number.isInteger(totalChunks) || totalChunks < 1) {
      throw new BadRequestException('filename e totalChunks (intero >= 1) richiesti');
    }
    return { uploadId: initChunkedUpload(filename, totalChunks) };
  }

  @Post('verify/upload/chunk/:uploadId/:index')
  @Roles('user', 'admin')
  @UseInterceptors(
    FileInterceptor('chunk', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
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

  @Post('verify/upload/complete/:uploadId')
  @Roles('user', 'admin')
  async completeUpload(
    @Param('uploadId') uploadId: string,
    @Body() body: VerifyDomicileBulkCompleteDto,
  ) {
    try {
      const { path } = await assembleChunkedUpload(uploadId);
      const csvContent = await fs.promises.readFile(path, 'utf-8');
      return await this.svc.createJob({
        csvContent,
        hasHeaders: body.hasHeaders,
        cfColumn: body.cfColumn,
        ioServiceId: body.ioServiceId,
      });
    } catch (err: any) {
      return { blocked: true, message: err?.message ?? 'Errore durante il riassemblaggio del CSV' };
    } finally {
      cleanupChunkedUpload(uploadId);
    }
  }

  @Get('jobs')
  @Roles('user', 'admin')
  listJobs() {
    return this.svc.listJobs().then((jobs) => ({ jobs }));
  }

  @Get('jobs/:id')
  @Roles('user', 'admin')
  getStatus(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getStatus(id);
  }

  @Get('jobs/:id/assenti.csv')
  @Roles('user', 'admin')
  async downloadAssenti(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    await this.sendCsv(id, 'assenti', res);
  }

  @Get('jobs/:id/app-io.csv')
  @Roles('user', 'admin')
  async downloadAppIo(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    await this.sendCsv(id, 'app-io', res);
  }

  @Get('jobs/:id/inad.csv')
  @Roles('user', 'admin')
  async downloadInad(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    await this.sendCsv(id, 'inad', res);
  }

  @Get('jobs/:id/registro-imprese.csv')
  @Roles('user', 'admin')
  async downloadRegistroImprese(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    await this.sendCsv(id, 'registro-imprese', res);
  }

  @Get('jobs/:id/aggregato.csv')
  @Roles('user', 'admin')
  async downloadAggregato(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    await this.sendCsv(id, 'aggregato', res);
  }

  private async sendCsv(id: string, variant: DomicileVerificationCsvVariant, res: Response): Promise<void> {
    const content = await this.svc.getResultCsv(id, variant);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="verifica_domicili_${FILENAME_BY_VARIANT[variant]}_${id.slice(0, 8)}.csv"`);
    res.send(content);
  }
}
