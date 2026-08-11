import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post, Req, UploadedFile, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import { Public } from '../auth/decorators/public.decorator';
import { ApiKeyGuard, type RequestWithApiClient } from './guards/api-key.guard';
import { ExternalApiExceptionFilter } from './external-api-exception.filter';
import { ExternalAttachmentTokensService } from './external-attachment-tokens.service';
import { chunkUploadDir, initChunkedUpload, isValidUploadId, MAX_CHUNK_SIZE_BYTES } from '../campaigns/chunked-upload.util';
import { InitAttachmentUploadDto } from './dto/init-attachment-upload.dto';
import { ChunkAttachmentUploadDto } from './dto/chunk-attachment-upload.dto';
import { CompleteAttachmentUploadDto } from './dto/complete-attachment-upload.dto';

// Solo cifre, nessun separatore di path: stesso principio di isValidUploadId
// (chunked-upload.util.ts) applicato all'indice del chunk — un valore tipo
// "../../evil" o "0/../../etc" finirebbe letteralmente in `${index}.part`
// dentro fs callback filename, PRIMA che una ValidationPipe/DTO possa
// intervenire (vedi commento su ChunkAttachmentUploadDto sotto).
const CHUNK_INDEX_PATTERN = /^\d+$/;

@Controller('external/v1/attachments/upload')
@Public()
@UseGuards(ApiKeyGuard)
@UseFilters(ExternalApiExceptionFilter)
export class ExternalAttachmentsController {
  constructor(private readonly tokens: ExternalAttachmentTokensService) {}

  @Post('init')
  @HttpCode(HttpStatus.OK)
  init(@Body() body: InitAttachmentUploadDto) {
    const uploadId = initChunkedUpload(body.filename, body.totalChunks);
    return { success: true, uploadId };
  }

  /**
   * Path traversal — finding critico review finale (follow-up al fix già
   * applicato su init()/filename): FileInterceptor (multer) elabora
   * `req.body.uploadId`/`req.body.index` nei callback `destination`/
   * `filename` del `diskStorage` DURANTE il parsing multipart, che avviene
   * come parte del `intercept()` dell'interceptor — quindi PRIMA che Nest
   * risolva gli argomenti `@Body()` decorati e la ValidationPipe globale
   * possa validare `ChunkAttachmentUploadDto`. Verificato leggendo l'ordine
   * di esecuzione Nest (Guards → Interceptors.pre → Pipes su @Body/@Param →
   * Handler): il DTO su `chunk()` sotto è difesa in profondità utile per
   * whitelisting/coerenza dei tipi (`index` come number), MAI la protezione
   * primaria contro la scrittura file — quella deve stare qui, dentro i
   * callback stessi, altrimenti un uploadId/index maligno scrive già su
   * disco prima che qualunque decorator possa reagire.
   */
  @Post('chunk')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('chunk', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const uploadId = (req.body as { uploadId?: string }).uploadId;
          if (!uploadId || !isValidUploadId(uploadId)) {
            return cb(new BadRequestException('uploadId non valido'), '');
          }
          let dir: string;
          try {
            dir = chunkUploadDir(uploadId);
          } catch {
            return cb(new BadRequestException('uploadId non valido'), '');
          }
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (req, _file, cb) => {
          const index = (req.body as { index?: string }).index;
          if (!index || !CHUNK_INDEX_PATTERN.test(index)) {
            return cb(new BadRequestException('index non valido'), '');
          }
          cb(null, `${index}.part`);
        },
      }),
      limits: { fileSize: MAX_CHUNK_SIZE_BYTES },
    }),
  )
  chunk(@UploadedFile() file: Express.Multer.File, @Body() _body: ChunkAttachmentUploadDto) {
    if (!file) throw new BadRequestException('chunk mancante');
    return { success: true };
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  async complete(@Body() body: CompleteAttachmentUploadDto, @Req() req: RequestWithApiClient) {
    const { token } = await this.tokens.completeUpload(req.apiClient.id, body.uploadId);
    return { success: true, attachmentToken: token };
  }
}
