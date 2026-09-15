import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class CercaDomicilioDto {
  @IsString() @MinLength(1)
  codiceFiscale!: string;

  // Forza il ramo Registro Imprese anche per un CF in formato persona
  // fisica/16 caratteri — serve per le imprese individuali, il cui CF ha
  // lo stesso formato del CF persona fisica (isPartitaIva() non le rileva).
  @IsOptional() @IsBoolean()
  forzaImpresa?: boolean;
}
