import 'reflect-metadata';
import { IsUUID } from 'class-validator';

/**
 * complete() riceve un body JSON puro (nessun multer/diskStorage in mezzo,
 * a differenza di chunk()) — qui la ValidationPipe globale gira PRIMA del
 * controller, quindi @IsUUID() è la protezione REALE, non solo difesa in
 * profondità: senza questo DTO, `uploadId` (interfaccia TS grezza prima di
 * questo fix) arrivava non validato fino a
 * ExternalAttachmentTokensService.completeUpload() →
 * assembleChunkedUpload() → chunkUploadDir()/readMeta() — un valore tipo
 * "../<altro-uploadId>" avrebbe potuto leggere/assemblare chunk fuori dalla
 * sessione di upload prevista. chunkUploadDir() valida comunque la stessa
 * forma come secondo livello (chunked-upload.util.ts), stesso principio già
 * in uso per ExternalAttachmentRefDto.token.
 */
export class CompleteAttachmentUploadDto {
  @IsUUID()
  uploadId!: string;
}
