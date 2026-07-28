import { Type } from 'class-transformer';
import { IsEnum, IsIn, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import type { NotificationChannel } from '@comunicapa/shared-types';

export class PreviewAttachmentDto {
  @IsString()
  @IsOptional()
  key?: string;

  @IsString()
  @IsOptional()
  label?: string;

  @IsString()
  @IsOptional()
  labelColumn?: string;
}

export class PreviewRecipientDto {
  @IsString()
  @IsOptional()
  codiceFiscale?: string;

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

  @IsString()
  @IsOptional()
  campaignId?: string;

  /** Canale primario reale, solo quando channelType==='APP_IO' e la co-consegna è PARALLELA (mai in esclusiva). */
  @IsEnum(['PEC', 'EMAIL', 'APP_IO', 'SEND', 'POSTAL'])
  @IsOptional()
  appIoParallelPrimaryChannel?: NotificationChannel;

  /** Mappatura colonne indirizzo postale (channelConfig.physicalAddressConfig), per formattare l'indirizzo nella cortesia POSTAL in anteprima. */
  @IsObject()
  @IsOptional()
  physicalAddressConfig?: Record<string, unknown>;
}

export interface PreviewMessageResult {
  subject: string;
  bodyHtml?: string;
  bodyMarkdown?: string;
}
