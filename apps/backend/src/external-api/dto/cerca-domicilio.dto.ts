import { IsString, Matches } from 'class-validator';

export class CercaDomicilioDto {
  @IsString()
  @Matches(/^([A-Za-z0-9]{16}|\d{11})$/, { message: 'taxId deve essere un codice fiscale di 16 caratteri o una partita IVA di 11 cifre' })
  taxId!: string;
}
