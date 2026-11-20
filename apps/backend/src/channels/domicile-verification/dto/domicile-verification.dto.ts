import { IsBoolean, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class VerifyDomicileBulkCompleteDto {
  @IsBoolean()
  hasHeaders!: boolean;

  @IsString() @MinLength(1)
  cfColumn!: string;

  @IsUUID()
  ioServiceId!: string;

  /** Verifica presenza CF in ANPR (C030, fino a 3 giorni). */
  @IsOptional() @IsBoolean()
  anprId?: boolean;

  /** Verifica esistenza in vita (C007, fino a 3 giorni). */
  @IsOptional() @IsBoolean()
  anprVita?: boolean;
}
