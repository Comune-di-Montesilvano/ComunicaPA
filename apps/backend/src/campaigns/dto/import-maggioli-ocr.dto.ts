import { ArrayMaxSize, IsArray, IsBoolean, IsOptional } from 'class-validator';

/**
 * Coppie [CF/P.IVA, OCR] estratte lato client dal CSV (solo le due colonne
 * scelte, per stare nel limite del body JSON). Il contenuto di ogni coppia
 * è validato nel service.
 */
export class ImportMaggioliOcrDto {
  @IsArray()
  @ArrayMaxSize(100_000)
  pairs!: Array<[string, string]>;

  /** true = solo anteprima del riepilogo, nessuna scrittura. */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
