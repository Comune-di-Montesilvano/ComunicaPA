import { IsString, MinLength } from 'class-validator';

export class CercaDomicilioDto {
  @IsString() @MinLength(1)
  codiceFiscale!: string;
}
