import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import type { NotificationChannel } from '@comunicapa/shared-types';

export class PreviewAttachmentDto {
  @IsString()
  @IsNotEmpty()
  key!: string;

  @IsString()
  label!: string;
}

export class PreviewRecipientDto {
  @IsString()
  @IsNotEmpty()
  codiceFiscale!: string;

  @IsString()
  @IsOptional()
  fullName?: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  pec?: string;

  @IsString()
  @IsOptional()
  protocolNumber?: string;

  @IsObject()
  @IsOptional()
  extraData?: Record<string, string>;
}

export class PreviewMessageDto {
  @IsEnum(['PEC', 'EMAIL', 'APP_IO', 'SEND', 'POSTAL'])
  channelType!: NotificationChannel;

  @IsString()
  subject!: string;

  @IsString()
  body!: string;

  @ValidateNested({ each: true })
  @Type(() => PreviewAttachmentDto)
  @IsOptional()
  attachments?: PreviewAttachmentDto[];

  @ValidateNested()
  @Type(() => PreviewRecipientDto)
  recipient!: PreviewRecipientDto;

  @IsIn(['html', 'markdown'])
  @IsOptional()
  format?: 'html' | 'markdown';
}

export interface PreviewMessageResult {
  subject: string;
  bodyHtml?: string;
  bodyMarkdown?: string;
}
