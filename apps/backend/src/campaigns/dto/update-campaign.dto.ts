import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateCampaignDto {
  @IsOptional() @IsString() @MaxLength(255)
  name?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @IsOptional() @IsObject()
  channelConfig?: Record<string, unknown>;
}
