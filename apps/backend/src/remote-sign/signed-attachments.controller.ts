// apps/backend/src/remote-sign/signed-attachments.controller.ts
import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import type { Request, Response } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator.js';
import {
  assembleChunkedUpload,
  initChunkedUpload,
  isValidChunkIndex,
  MAX_CHUNK_SIZE_BYTES,
  safeChunkUploadDir,
} from '../campaigns/chunked-upload.util.js';
import { RemoteSignService } from './remote-sign.service.js';
import { SignedAttachmentsService } from './signed-attachments.service.js';

@Controller('admin/campaigns/:id')
@Roles('user', 'admin')
export class SignedAttachmentsController {
  constructor(
    private readonly service: SignedAttachmentsService,
    private readonly remoteSign: RemoteSignService,
  ) {}

  @Get('signature/unsigned.zip')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: JwtOperatorPayload },
    @Res() res: Response,
  ): Promise<void> {
    const result = await this.service.buildUnsignedZip(id, { username: req.user.username, role: req.user.role });
    if (!Buffer.isBuffer(result)) {
      res.status(200).json(result);
      return;
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="allegati-da-firmare.zip"');
    res.send(result);
  }

  // Stesso schema chunked di :id/attachments/upload/* (limite body del
  // reverse proxy esterno): init/chunk identici, complete dedicato.
  @Post('signed-attachments/upload/init')
  @HttpCode(200)
  init(@Body() body: { filename?: string; totalChunks?: number }): { uploadId: string } {
    const filename = body.filename?.trim();
    const totalChunks = Number(body.totalChunks);
    if (!filename || !Number.isInteger(totalChunks) || totalChunks < 1) {
      throw new BadRequestException('filename e totalChunks (intero >= 1) richiesti');
    }
    return { uploadId: initChunkedUpload(filename, totalChunks) };
  }

  @Post('signed-attachments/upload/chunk/:uploadId/:index')
  @HttpCode(200)
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
  chunk(): { ok: true } {
    return { ok: true };
  }

  @Post('signed-attachments/upload/complete/:uploadId')
  @HttpCode(200)
  async complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('uploadId') uploadId: string,
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    const requester = { username: req.user.username, role: req.user.role };
    // Permessi PRIMA di assemblare: niente file su disco per chi non può modificare.
    await this.remoteSign.assertCanModify(id, requester);
    const { path, filename } = await assembleChunkedUpload(uploadId);
    return this.service.applySignedUpload(id, requester, path, filename);
  }
}
