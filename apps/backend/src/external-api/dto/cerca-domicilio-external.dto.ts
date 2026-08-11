import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class CercaDomicilioExternalDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9]{16}$/, { message: 'codiceFiscale deve essere alfanumerico di 16 caratteri' })
  codiceFiscale!: string;
}
