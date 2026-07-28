import { IsOptional, IsString } from 'class-validator';

export class UpdateCampaignContentDto {
  @IsString()
  @IsOptional()
  subject?: string;

  @IsString()
  @IsOptional()
  body?: string;
}
