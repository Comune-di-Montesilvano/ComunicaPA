import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * Il campo `extraData` è l'intera riga del primo destinatario del CSV
 * (stesse chiavi = nomi colonna raw usati da wizMapping/labelColumn/
 * attachment config), con CF/email/pec/colonne indirizzo postale già
 * sovrascritte dall'operatore lato frontend — il backend non conosce e
 * non deve dedurre quali colonne mappano a cosa, riceve il dato già pronto.
 */
export class TestSendDto {
  @IsString()
  @IsNotEmpty()
  codiceFiscale!: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  pec?: string;

  @IsObject()
  extraData!: Record<string, string>;
}
