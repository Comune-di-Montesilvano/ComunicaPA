import 'reflect-metadata';
import { ArrayMinSize, Equals, IsArray, IsIn, IsObject, IsOptional, IsString, Length, Matches, ValidateIf, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { NotificationChannel } from '@comunicapa/shared-types';

const CF_PATTERN = /^[A-Za-z0-9]{16}$/;

class ExternalAttachmentRefDto {
  @IsString()
  token!: string;

  @IsString()
  @IsOptional()
  label?: string;
}

/**
 * Stesso principio di TestSendDto (test-send.dto.ts): `extraData` porta
 * qualunque colonna aggiuntiva il chiamante voglia passare (es. indirizzo
 * postale completo per POSTAL) — il backend non deduce mapping, il
 * chiamante esterno mette le chiavi che il canale scelto si aspetta.
 *
 * Validazione nuova, non esiste altrove nel backend fuori dal frontend
 * wizard (vedi design doc): questo DTO è l'UNICO gate per un payload che
 * arriva senza mai passare dalle validazioni client-side di App.tsx.
 */
class SecondaryAppIoDto {
  @IsString()
  @IsOptional()
  subjectOverride?: string;

  @IsString()
  @IsOptional()
  bodyOverride?: string;
}

export class CreateExternalNotificationDto {
  @IsIn(['PEC', 'EMAIL', 'APP_IO', 'SEND', 'POSTAL'])
  channelType!: NotificationChannel;

  /**
   * Co-consegna App IO in parallelo (mai esclusiva — vedi design doc,
   * sezione "Eccezione — App IO parallela": l'esclusiva presuppone un check
   * di dirottamento che il client ha già fatto a monte via domicilio/cerca).
   */
  @ValidateNested()
  @Type(() => SecondaryAppIoDto)
  @IsOptional()
  secondaryAppIo?: SecondaryAppIoDto;

  @IsString()
  @Matches(CF_PATTERN, { message: 'codiceFiscale deve essere alfanumerico di 16 caratteri' })
  codiceFiscale!: string;

  @ValidateIf((o) => o.channelType === 'EMAIL' && !o.pec)
  @IsString({ message: 'email obbligatoria per canale EMAIL (o valorizzare pec)' })
  email?: string;

  @ValidateIf((o) => o.channelType === 'PEC' && !o.email)
  @IsString({ message: 'pec obbligatoria per canale PEC (o valorizzare email)' })
  pec?: string;

  @IsObject()
  extraData!: Record<string, string>;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExternalAttachmentRefDto)
  @IsOptional()
  @ValidateIf((o) => o.channelType === 'SEND' || o.channelType === 'POSTAL')
  @ArrayMinSize(1, { message: 'attachments obbligatorio (almeno 1) per SEND e POSTAL' })
  attachments?: ExternalAttachmentRefDto[];

  @ValidateIf((o) => o.channelType === 'SEND')
  @Equals(true, { message: 'protocolla deve essere true per canale SEND' })
  protocolla?: boolean;

  @ValidateIf((o) => o.channelType === 'APP_IO')
  @IsString()
  @Length(10, 120, { message: 'subject deve avere lunghezza tra 10 e 120 caratteri' })
  subject?: string;

  @ValidateIf((o) => o.channelType === 'APP_IO')
  @IsString()
  @Length(80, 10000, { message: 'body deve avere lunghezza tra 80 e 10000 caratteri' })
  body?: string;
}
