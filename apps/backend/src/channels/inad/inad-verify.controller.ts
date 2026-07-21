import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Res, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import { Roles } from '../../auth/decorators/roles.decorator';
import { InadService } from './inad.service';
import { InadVerifyBulkService } from './inad-verify-bulk.service';
import { VerifyInadSingleDto, VerifyInadBulkCompleteDto } from './dto/inad-verify.dto';
import { initChunkedUpload, chunkUploadDir, assembleChunkedUpload, cleanupChunkedUpload, MAX_CHUNK_SIZE_BYTES } from '../../campaigns/chunked-upload.util';

@Controller('admin/inad-verify')
export class InadVerifyController {
  constructor(
    private readonly inadService: InadService,
    private readonly bulkSvc: InadVerifyBulkService,
  ) {}

  @Post('verify-single')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  async verifySingle(@Body() body: VerifyInadSingleDto) {
    const cf = body.codiceFiscale.toUpperCase().trim();
    try {
      const result = await this.inadService.extractDigitalAddress(cf);
      if (!result.found) {
        return { success: true, found: false, message: 'Nessun domicilio digitale trovato su INAD per questo codice fiscale' };
      }
      return {
        success: true,
        found: true,
        message: 'Domicilio digitale trovato su INAD',
        digitalAddress: result.data?.digitalAddress ?? [],
      };
    } catch (err: any) {
      return { success: false, found: false, message: `Errore verifica INAD: ${err.message}` };
    }
  }

  @Post('verify-bulk/upload/init')
  @Roles('user', 'admin')
  initVerifyBulkUpload(@Body() body: { filename?: string; totalChunks?: number }): { uploadId: string } {
    const filename = body.filename?.trim();
    const totalChunks = Number(body.totalChunks);
    if (!filename || !Number.isInteger(totalChunks) || totalChunks < 1) {
      throw new BadRequestException('filename e totalChunks (intero >= 1) richiesti');
    }
    return { uploadId: initChunkedUpload(filename, totalChunks) };
  }

  @Post('verify-bulk/upload/chunk/:uploadId/:index')
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
  uploadVerifyBulkChunk(): { ok: true } {
    return { ok: true };
  }

  @Post('verify-bulk/upload/complete/:uploadId')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  async completeVerifyBulkUpload(
    @Param('uploadId') uploadId: string,
    @Body() body: VerifyInadBulkCompleteDto,
  ) {
    try {
      const { path } = await assembleChunkedUpload(uploadId);
      const csvContent = await fs.promises.readFile(path, 'utf-8');
      return await this.bulkSvc.createJob({
        csvContent,
        hasHeaders: body.hasHeaders,
        cfColumn: body.cfColumn,
      });
    } catch (err: any) {
      return { blocked: true, message: err?.message ?? 'Errore durante il riassemblaggio del CSV' };
    } finally {
      cleanupChunkedUpload(uploadId);
    }
  }

  @Get('verify-bulk/:id')
  @Roles('user', 'admin')
  getVerifyBulkStatus(@Param('id', ParseUUIDPipe) id: string) {
    return this.bulkSvc.getStatus(id);
  }

  @Get('verify-bulk/:id/found.csv')
  @Roles('user', 'admin')
  async downloadVerifyBulkFound(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const content = await this.bulkSvc.getResultCsv(id, 'found');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="verifica_inad_trovati_${id.slice(0, 8)}.csv"`);
    res.send(content);
  }

  @Get('verify-bulk/:id/notfound.csv')
  @Roles('user', 'admin')
  async downloadVerifyBulkNotFound(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const content = await this.bulkSvc.getResultCsv(id, 'notfound');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="verifica_inad_non_trovati_${id.slice(0, 8)}.csv"`);
    res.send(content);
  }
}
