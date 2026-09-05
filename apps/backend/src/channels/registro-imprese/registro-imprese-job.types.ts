export const REGISTRO_IMPRESE_QUEUE = 'registro-imprese-verify';
export const VERIFY_PIVA_JOB_NAME = 'verify-piva';

export interface RegistroImpreseVerifyJobData {
  jobId: string;
  partitaIva: string;
}

/**
 * Verifica PIVA per il check "dirottamento domicilio digitale" al lancio di
 * una campagna massiva (>= INAD_BULK_THRESHOLD, campaigns.service.ts) — a
 * differenza di VERIFY_PIVA_JOB_NAME (job dell'ad-hoc "Verifica INAD
 * Massiva", scrive su inad_verification_jobs) questo job scrive
 * direttamente su recipients.inad_check/pec, stesso schema già usato dal
 * loop sincrono runInadExtractLoop per campagne piccole. Stessa coda/worker
 * (stesso rate limiter 5/sec verso Registro Imprese) — solo job.name diverso.
 */
export const VERIFY_PIVA_CAMPAIGN_JOB_NAME = 'verify-piva-campaign';

export interface RegistroImpreseCampaignVerifyJobData {
  campaignId: string;
  recipientId: string;
  partitaIva: string;
  /** Per il campo audit inadCheck.originalAddress: PEC se campagna PEC, altrimenti email. */
  originalChannel: string;
  originalAddress: string | null;
  /**
   * Base di confronto reale per `diverted` — SEMPRE `recipient.pec` grezzo,
   * indipendente dal canale campagna (stessa semantica del loop sincrono
   * runInadExtractLoop in campaigns.service.ts, mai `originalAddress`).
   */
  recipientPec: string | null;
}
