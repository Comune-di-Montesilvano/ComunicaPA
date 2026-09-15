import { IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Ricerca ANPR C002 per anagrafica pura (senza CF) — tutti i campi
 * obbligatori tranne provinciaNascita, verificato dal vivo contro ANPR
 * (vedi AnprService.getGeneralitaByAnagrafica). motivoRichiesta è
 * obbligatorio e deve riferirsi a una pratica reale (es. n. procedimento
 * esproprio) — qui la ricerca è senza CF, tracciabilità ancora più
 * importante che per /cerca.
 */
export class CercaDomicilioAnagraficaDto {
  @IsString() @MinLength(1)
  cognome!: string;

  @IsString() @MinLength(1)
  nome!: string;

  @IsString() @MinLength(1)
  sesso!: string;

  @IsString() @MinLength(1)
  dataNascita!: string;

  @IsString() @MinLength(1)
  comuneNascita!: string;

  @IsOptional() @IsString()
  provinciaNascita?: string;

  @IsString() @MinLength(1)
  motivoRichiesta!: string;
}
