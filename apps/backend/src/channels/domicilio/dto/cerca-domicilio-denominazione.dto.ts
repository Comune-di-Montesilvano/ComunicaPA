import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Ricerca Registro Imprese per denominazione (helper "Non hai il codice
 * fiscale?" → modalità Impresa) — GET /ricerca/denominazione, min 2 max 50
 * caratteri (stesso vincolo dello spec PCAD-PDND).
 */
export class CercaDomicilioDenominazioneDto {
  @IsString() @MinLength(2) @MaxLength(50)
  denominazione!: string;

  @IsOptional() @IsString() @MaxLength(2)
  siglaProvincia?: string;
}
