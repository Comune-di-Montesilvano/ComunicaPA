// apps/backend/src/remote-sign/signed-attachments.controller.ts
import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator.js';
import {
  assembleChunkedUpload,
  assertChunkedUploadAccess,
  cleanupChunkedUpload,
  initChunkedUpload,
  operatorChunkUploadOptions,
  operatorUploadOwner,
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
  init(
    @Body() body: { filename?: string; totalChunks?: number },
    @Req() req: Request & { user: JwtOperatorPayload },
  ): { uploadId: string } {
    const filename = body.filename?.trim();
    const totalChunks = Number(body.totalChunks);
    if (!filename || !Number.isInteger(totalChunks) || totalChunks < 1) {
      throw new BadRequestException('filename e totalChunks (intero >= 1) richiesti');
    }
    return { uploadId: initChunkedUpload(filename, totalChunks, operatorUploadOwner(req.user)) };
  }

  @Post('signed-attachments/upload/chunk/:uploadId/:index')
  @HttpCode(200)
  @UseInterceptors(
    FileInterceptor('chunk', operatorChunkUploadOptions()),
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
    // 400 uploadId malformato, 404 sessione inesistente o di un altro
    // operatore: prima del try, una sessione altrui non va mai rimossa.
    assertChunkedUploadAccess(uploadId, operatorUploadOwner(req.user));
    const requester = { username: req.user.username, role: req.user.role };
    try {
      // Permessi PRIMA di assemblare: niente file assemblato per chi non può modificare.
      await this.remoteSign.assertCanModify(id, requester);
      const { path, filename } = await assembleChunkedUpload(uploadId);
      return await this.service.applySignedUpload(id, requester, path, filename);
    } finally {
      // Chunk e file assemblato contengono i documenti firmati: mai lasciati
      // su disco, qualunque sia l'esito.
      cleanupChunkedUpload(uploadId);
    }
  }
}
