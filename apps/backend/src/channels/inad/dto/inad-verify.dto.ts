import { IsString, MinLength } from 'class-validator';

export class VerifyInadSingleDto {
  @IsString() @MinLength(1)
  codiceFiscale!: string;
}
