import 'reflect-metadata';
import { IsInt, IsUUID, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Difesa in profondità, NON la protezione primaria contro il path
 * traversal su chunk(): FileInterceptor (multer, diskStorage) elabora
 * `req.body.uploadId`/`req.body.index` nei callback `destination`/
 * `filename` (external-attachments.controller.ts) DURANTE il parsing
 * multipart, che avviene PRIMA che Nest risolva gli argomenti `@Body()` e
 * quindi prima che questa ValidationPipe possa intervenire — un
 * uploadId/index maligno avrebbe già scritto su disco nel momento in cui
 * questo DTO verrebbe validato. La vera protezione sta nei controlli
 * manuali dentro i callback diskStorage stessi (isValidUploadId() +
 * CHUNK_INDEX_PATTERN). Questo DTO whitelist-a comunque il body (coerente
 * con lo stesso pattern usato per InitAttachmentUploadDto/
 * CreateExternalNotificationDto) e normalizza `index` a number per il
 * resto della pipeline.
 */
export class ChunkAttachmentUploadDto {
  @IsUUID()
  uploadId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  index!: number;
}
