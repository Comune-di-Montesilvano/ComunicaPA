import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Res, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import { Roles } from '../auth/decorators/roles.decorator';
import { IoServicesService } from './io-services.service';
import { AppIoVerifyBulkService } from './app-io-verify-bulk.service';
import { CreateIoServiceDto, UpdateIoServiceDto, TestIoServiceDto, VerifyBulkCompleteDto } from './dto/io-service.dto';
import { initChunkedUpload, chunkUploadDir, assembleChunkedUpload, cleanupChunkedUpload, MAX_CHUNK_SIZE_BYTES } from '../campaigns/chunked-upload.util';

@Controller('admin/io-services')
export class IoServicesController {
  constructor(
    private readonly svc: IoServicesService,
    private readonly bulkSvc: AppIoVerifyBulkService,
  ) {}

  @Get()
  @Roles('user', 'admin')
  list() {
    return this.svc.listMasked().then((configs) => ({ configs }));
  }

  @Post()
  @Roles('admin')
  create(@Body() dto: CreateIoServiceDto) {
    return this.svc.create(dto);
  }

  @Put(':id')
  @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateIoServiceDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(id);
  }

  @Patch(':id/default')
  @Roles('admin')
  setDefault(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.setDefault(id);
  }

  @Post(':id/test')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  test(@Param('id', ParseUUIDPipe) id: string, @Body() body: TestIoServiceDto) {
    return this.svc.test(id, body.codiceFiscale);
  }

  @Post('verify-profile')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  verifyProfile(@Body() body: { codiceFiscale: string }) {
    return this.svc.verifyProfile(body.codiceFiscale);
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
    @Body() body: VerifyBulkCompleteDto,
  ) {
    try {
      const { path } = await assembleChunkedUpload(uploadId);
      const csvContent = await fs.promises.readFile(path, 'utf-8');
      return await this.bulkSvc.createJob({
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

  @Get('verify-bulk/:id')
  @Roles('user', 'admin')
  getVerifyBulkStatus(@Param('id', ParseUUIDPipe) id: string) {
    return this.bulkSvc.getStatus(id);
  }

  @Get('verify-bulk/:id/present.csv')
  @Roles('user', 'admin')
  async downloadVerifyBulkPresent(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const content = await this.bulkSvc.getResultCsv(id, 'present');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="verifica_appio_presenti_${id.slice(0, 8)}.csv"`);
    res.send(content);
  }

  @Get('verify-bulk/:id/absent.csv')
  @Roles('user', 'admin')
  async downloadVerifyBulkAbsent(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const content = await this.bulkSvc.getResultCsv(id, 'absent');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="verifica_appio_assenti_${id.slice(0, 8)}.csv"`);
    res.send(content);
  }
}
