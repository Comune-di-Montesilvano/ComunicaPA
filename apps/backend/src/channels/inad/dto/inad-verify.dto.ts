import { IsBoolean, IsString, MinLength } from 'class-validator';

export class VerifyInadSingleDto {
  @IsString() @MinLength(1)
  codiceFiscale!: string;
}

export class VerifyInadBulkCompleteDto {
  @IsBoolean()
  hasHeaders!: boolean;

  @IsString() @MinLength(1)
  cfColumn!: string;
}
