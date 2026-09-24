import { UnauthorizedException } from '@nestjs/common';
import type { CitizenTokenClaims } from '@comunicapa/shared-types';

/**
 * Tipo di accesso del portale cittadino:
 * - PF: persona fisica, identificata dal proprio codice fiscale;
 * - PG: persona che opera per conto di un'impresa (SPID persona giuridica,
 *   scope `legal_entity` del proxy), identificata dalla coppia
 *   (codice fiscale della persona, P.IVA dell'impresa).
 */
export type CitizenAccessType = 'PF' | 'PG';

export interface CitizenSessionClaims extends CitizenTokenClaims {
  accessType?: CitizenAccessType;
  ivaCode?: string;
  companyName?: string;
  registeredOffice?: string;
}

/** Contesto di sessione salvato su Redis al callback, legato al singolo token. */
export interface CitizenSessionContext {
  accessType: CitizenAccessType;
  codiceFiscale: string;
  name: string;
  provider: string;
  ivaCode?: string;
  companyName?: string;
  registeredOffice?: string;
}

/** Rimuove i prefissi SPID (`TINIT-` sul codice fiscale, `VATIT-` sulla P.IVA). */
export function normalizeTaxId(raw: string): string {
  return raw.trim().toUpperCase().replace(/^(TIN|VAT)[A-Z]{2}-/, '');
}

/**
 * Chiave con cui cercare i destinatari del portale: codice fiscale per la
 * persona fisica, P.IVA per l'operatore d'impresa. Una sessione impresa
 * senza P.IVA non deve mai ricadere sul codice fiscale personale.
 */
export function recipientKeyOf(user: CitizenSessionClaims): string {
  if (user.accessType === 'PG') {
    if (!user.ivaCode) throw new UnauthorizedException('Sessione impresa priva di P.IVA: effettua di nuovo l\'accesso');
    return user.ivaCode;
  }
  return user.codiceFiscale;
}
