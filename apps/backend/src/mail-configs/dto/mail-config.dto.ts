import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { MailServerType } from '../../entities/mail-server-config.entity';

export class CreateMailConfigDto {
  @IsIn(['EMAIL', 'PEC'])
  type!: MailServerType;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsBoolean()
  secure!: boolean;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsBoolean()
  authEnabled!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsEmail()
  fromAddress!: string;

  @IsInt()
  @Min(1)
  batchSize!: number;

  @IsInt()
  @Min(1)
  batchIntervalSeconds!: number;
}

// Update: stessi campi ma tutti opzionali tranne type che NON è modificabile
export class UpdateMailConfigDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128)
  name?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(255)
  host?: string;

  @IsOptional() @IsInt() @Min(1) @Max(65535)
  port?: number;

  @IsOptional() @IsBoolean()
  secure?: boolean;

  @IsOptional() @IsBoolean()
  isDefault?: boolean;

  @IsOptional() @IsBoolean()
  authEnabled?: boolean;

  @IsOptional() @IsString() @MaxLength(255)
  username?: string;

  @IsOptional() @IsString()
  password?: string;

  @IsOptional() @IsEmail()
  fromAddress?: string;

  @IsOptional() @IsInt() @Min(1)
  batchSize?: number;

  @IsOptional() @IsInt() @Min(1)
  batchIntervalSeconds?: number;
}

export interface MailConfigMaskedDto {
  id: string;
  type: MailServerType;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  authEnabled: boolean;
  username: string;
  password: string; // MASKED_VALUE se impostata, '' altrimenti
  fromAddress: string;
  batchSize: number;
  batchIntervalSeconds: number;
  testedAt: string | null;
  active: boolean;
  isDefault: boolean;
}

export class TestMailConfigDto {
  @IsEmail()
  to!: string;
}

export class SetActiveMailConfigDto {
  @IsBoolean()
  active!: boolean;
}
