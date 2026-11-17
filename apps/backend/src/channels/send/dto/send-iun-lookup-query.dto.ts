import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { SEND_LOOKUP_MAX_LENGTH } from '../send-iun-lookup.service.js';

export class SendIunLookupQueryDto {
  /** Numero di protocollo esattamente come inserito nella notifica (es. `12345` o `4321/2026`). */
  @IsString() @MinLength(1) @MaxLength(SEND_LOOKUP_MAX_LENGTH)
  protocollo!: string;

  /** idempotenceToken del gestionale che ha inviato; vuoto = "null" (invii dal portale SEND). */
  @IsOptional() @IsString() @MaxLength(SEND_LOOKUP_MAX_LENGTH)
  token?: string;
}
