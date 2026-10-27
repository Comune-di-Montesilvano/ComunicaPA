import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Req, Res, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { DomicileVerificationService, DomicileVerificationCsvVariant } from './domicile-verification.service.js';
import { VerifyDomicileBulkCompleteDto } from './dto/domicile-verification.dto.js';
import { initChunkedUpload, safeChunkUploadDir, isValidChunkIndex, assembleChunkedUpload, cleanupChunkedUpload, MAX_CHUNK_SIZE_BYTES } from '../../campaigns/chunked-upload.util.js';

type OperatorRequest = Request & { user: JwtOperatorPayload };

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
    @Req() req: OperatorRequest,
  ) {
    try {
      const { path } = await assembleChunkedUpload(uploadId);
      const csvContent = await fs.promises.readFile(path, 'utf-8');
      return await this.svc.createJob({
        csvContent,
        hasHeaders: body.hasHeaders,
        cfColumn: body.cfColumn,
        ioServiceId: body.ioServiceId,
        createdBy: req.user.username,
      });
    } catch (err: any) {
      return { blocked: true, message: err?.message ?? 'Errore durante il riassemblaggio del CSV' };
    } finally {
      cleanupChunkedUpload(uploadId);
    }
  }

  @Get('jobs')
  @Roles('user', 'admin')
  listJobs(@Req() req: OperatorRequest) {
    return this.svc.listJobs(req.user).then((jobs) => ({ jobs }));
  }

  @Get('jobs/:id')
  @Roles('user', 'admin')
  getStatus(@Param('id', ParseUUIDPipe) id: string, @Req() req: OperatorRequest) {
    return this.svc.getStatus(id, req.user);
  }

  @Delete('jobs/:id')
  @Roles('user', 'admin')
  async deleteJob(@Param('id', ParseUUIDPipe) id: string, @Req() req: OperatorRequest): Promise<{ ok: true }> {
    await this.svc.deleteJob(id, req.user);
    return { ok: true };
  }

  @Post('jobs/:id/skip-inad')
  @Roles('admin')
  async skipInad(@Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    await this.svc.skipInad(id);
    return { ok: true };
  }

  @Get('jobs/:id/assenti.csv')
  @Roles('user', 'admin')
  async downloadAssenti(@Param('id', ParseUUIDPipe) id: string, @Req() req: OperatorRequest, @Res() res: Response): Promise<void> {
    await this.sendCsv(id, 'assenti', req, res);
  }

  @Get('jobs/:id/app-io.csv')
  @Roles('user', 'admin')
  async downloadAppIo(@Param('id', ParseUUIDPipe) id: string, @Req() req: OperatorRequest, @Res() res: Response): Promise<void> {
    await this.sendCsv(id, 'app-io', req, res);
  }

  @Get('jobs/:id/inad.csv')
  @Roles('user', 'admin')
  async downloadInad(@Param('id', ParseUUIDPipe) id: string, @Req() req: OperatorRequest, @Res() res: Response): Promise<void> {
    await this.sendCsv(id, 'inad', req, res);
  }

  @Get('jobs/:id/registro-imprese.csv')
  @Roles('user', 'admin')
  async downloadRegistroImprese(@Param('id', ParseUUIDPipe) id: string, @Req() req: OperatorRequest, @Res() res: Response): Promise<void> {
    await this.sendCsv(id, 'registro-imprese', req, res);
  }

  @Get('jobs/:id/aggregato.csv')
  @Roles('user', 'admin')
  async downloadAggregato(@Param('id', ParseUUIDPipe) id: string, @Req() req: OperatorRequest, @Res() res: Response): Promise<void> {
    await this.sendCsv(id, 'aggregato', req, res);
  }

  private async sendCsv(id: string, variant: DomicileVerificationCsvVariant, req: OperatorRequest, res: Response): Promise<void> {
    const content = await this.svc.getResultCsv(id, variant, req.user);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="verifica_domicili_${FILENAME_BY_VARIANT[variant]}_${id.slice(0, 8)}.csv"`);
    res.send(content);
  }
}
