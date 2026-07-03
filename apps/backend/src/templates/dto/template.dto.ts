import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import type { TemplateType } from '../../entities/template.entity';

export class CreateTemplateDto {
  @IsIn(['MAIL', 'APP_IO'])
  type!: TemplateType;

  @IsString() @MinLength(1) @MaxLength(128)
  name!: string;

  @IsString() @MaxLength(255)
  subject!: string;

  @ValidateIf((o) => o.type === 'MAIL')
  @IsString()
  bodyHtml?: string;

  @ValidateIf((o) => o.type === 'APP_IO')
  @IsString()
  bodyMarkdown?: string;

  @IsOptional() @IsUUID()
  pairedTemplateId?: string;
}

export class UpdateTemplateDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128)
  name?: string;

  @IsOptional() @IsString() @MaxLength(255)
  subject?: string;

  @IsOptional() @IsString()
  bodyHtml?: string;

  @IsOptional() @IsString()
  bodyMarkdown?: string;

  @IsOptional() @IsUUID()
  pairedTemplateId?: string;
}
