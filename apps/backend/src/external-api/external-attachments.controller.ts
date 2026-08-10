import { BadRequestException, Body, Controller, Post, Req, UploadedFile, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import { Public } from '../auth/decorators/public.decorator';
import { ApiKeyGuard, type RequestWithApiClient } from './guards/api-key.guard';
import { ExternalApiExceptionFilter } from './external-api-exception.filter';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service';
import { chunkUploadDir, initChunkedUpload, MAX_CHUNK_SIZE_BYTES } from '../campaigns/chunked-upload.util';

@Controller('external/v1/attachments/upload')
@Public()
@UseGuards(ApiKeyGuard)
@UseFilters(ExternalApiExceptionFilter)
export class ExternalAttachmentsController {
  constructor(private readonly tokens: ExternalAttachmentTokensService) {}

  @Post('init')
  init(@Body() body: { filename: string; totalChunks: number }) {
    const uploadId = initChunkedUpload(body.filename, body.totalChunks);
    return { success: true, uploadId };
  }

  @Post('chunk')
  @UseInterceptors(
    FileInterceptor('chunk', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const uploadId = (req.body as { uploadId?: string }).uploadId;
          if (!uploadId) return cb(new BadRequestException('uploadId mancante'), '');
          const dir = chunkUploadDir(uploadId);
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (req, _file, cb) => {
          const index = (req.body as { index?: string }).index;
          cb(null, `${index}.part`);
        },
      }),
      limits: { fileSize: MAX_CHUNK_SIZE_BYTES },
    }),
  )
  chunk(@UploadedFile() file: Express.Multer.File, @Body() _body: { uploadId: string; index: string }) {
    if (!file) throw new BadRequestException('chunk mancante');
    return { success: true };
  }

  @Post('complete')
  async complete(@Body() body: { uploadId: string }, @Req() req: RequestWithApiClient) {
    const { token } = await this.tokens.completeUpload(req.apiClient.id, body.uploadId);
    return { success: true, attachmentToken: token };
  }
}
