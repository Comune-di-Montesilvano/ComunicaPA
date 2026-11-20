import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class SetRecipientExternalIdDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  // Niente caratteri di controllo: finisce in CSV e tracciati a lunghezza fissa.
  @Matches(/^[^\x00-\x1f\x7f]+$/, { message: 'External ID non valido' })
  externalId!: string;
}
