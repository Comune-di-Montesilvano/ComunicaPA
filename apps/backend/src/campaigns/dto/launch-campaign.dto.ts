import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Body facoltativo di POST /campaigns/:id/launch. Senza body il lancio resta
 * quello di sempre (nessun flag = nessuna forzatura).
 */
export class LaunchCampaignDto {
  /**
   * SEND massivo: procede anche se la verifica firma ha trovato allegati non
   * firmati validamente — l'operatore ha già confermato l'avviso legale lato
   * frontend. Ignorato se la verifica non è ancora conclusa.
   */
  @IsBoolean()
  @IsOptional()
  forceUnsignedAttachments?: boolean;
}
