import type { Recipient } from '../entities/recipient.entity.js';

/**
 * Destinatario durante l'invio: il processor aggiunge campi di lavoro usati dai
 * segnaposto del template e dalle strategie. Mai colonne, mai persistiti.
 */
export type RecipientInFlight = Recipient & {
  /** Protocollo dell'attempt in corso, `numero/anno`. */
  protocolNumber?: string;
  /** Numero dell'attempt in corso (1 = primo invio). */
  attemptNumber?: number;
};
