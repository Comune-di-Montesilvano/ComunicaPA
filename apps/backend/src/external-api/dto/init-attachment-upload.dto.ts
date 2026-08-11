import 'reflect-metadata';
import { IsInt, IsNotEmpty, IsString, Min, MaxLength } from 'class-validator';

/**
 * Prima di questo DTO, `init()` (external-attachments.controller.ts)
 * accettava `@Body() body: { filename: string; totalChunks: number }` — una
 * semplice interfaccia TS, non una classe validata: la `ValidationPipe`
 * globale (whitelist mode) non fa nulla su un tipo che non è una classe con
 * decorator, quindi `filename` arrivava non sanitizzato fino a
 * `initChunkedUpload()`/`ExternalAttachmentTokensService.completeUpload()`
 * (vedi fix path-traversal in chunked-upload.util.ts — `basename()` chiude
 * il buco a valle, ma questo DTO chiude anche l'ingresso con lo stesso
 * whitelisting che ogni altra route di questo feature già ha).
 */
export class InitAttachmentUploadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename!: string;

  @IsInt()
  @Min(1)
  totalChunks!: number;
}
