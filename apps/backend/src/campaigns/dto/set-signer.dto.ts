import { IsOptional, IsString, MaxLength } from 'class-validator';

/** `signerUsername: null` (o assente) azzera il firmatario. */
export class SetSignerDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  signerUsername?: string | null;
}
