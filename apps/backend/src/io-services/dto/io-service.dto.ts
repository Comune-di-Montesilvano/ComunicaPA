import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateIoServiceDto {
  @IsString() @MinLength(1) @MaxLength(128)
  nome!: string;

  @IsString() @MinLength(1) @MaxLength(64)
  idService!: string;

  @IsOptional() @IsString()
  descrizione?: string;

  @IsString() @MinLength(1)
  apiKeyPrimaria!: string;

  @IsOptional() @IsString()
  apiKeySecondaria?: string;

  @IsOptional() @IsString() @MaxLength(32)
  codiceCatalogo?: string;

  @IsOptional() @IsBoolean()
  isDefault?: boolean;
}

export class UpdateIoServiceDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128)
  nome?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(64)
  idService?: string;

  @IsOptional() @IsString()
  descrizione?: string;

  @IsOptional() @IsString()
  apiKeyPrimaria?: string;

  @IsOptional() @IsString()
  apiKeySecondaria?: string;

  @IsOptional() @IsString() @MaxLength(32)
  codiceCatalogo?: string;
}

export interface IoServiceMaskedDto {
  id: string;
  nome: string;
  idService: string;
  descrizione: string;
  apiKeyPrimaria: string; // MASKED_VALUE se impostata
  apiKeySecondaria: string;
  codiceCatalogo: string;
  isDefault: boolean;
  testedAt: string | null;
}

export class TestIoServiceDto {
  @IsString() @MinLength(1)
  codiceFiscale!: string;
}

export class VerifyBulkDto {
  @IsString() @MinLength(1)
  csvContent!: string;

  @IsBoolean()
  hasHeaders!: boolean;

  @IsString() @MinLength(1)
  cfColumn!: string;

  @IsUUID()
  ioServiceId!: string;
}
