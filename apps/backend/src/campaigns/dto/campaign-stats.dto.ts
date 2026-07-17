export interface CampaignStatsDto {
  campaignId: string;
  totalRecipients: number;
  totalSent: number;
  totalDownloaded: number;
  downloadPercentage: number;
  lastDownloadAt: Date | null;
}

export interface RecipientStatDto {
  id: string;
  fullName: string | null;
  codiceFiscale: string;
  email: string | null;
  pec: string | null;
  status: string;
  downloadCount: number;
  firstDownloadedAt: Date | null;
  lastDownloadedAt: Date | null;
  attachmentDeletedAt: Date | null;
  /** Presenti solo per campagne SEND o POSTAL (join su ultimo NotificationAttempt). */
  iun?: string | null;
  sendStatus?: string | null;
  sendStatusUpdatedAt?: Date | null;
  protocolNumber?: number | null;
  protocolYear?: number | null;
  postalTrackingId?: string | null;
  postalStatus?: string | null;
  postalStatusUpdatedAt?: Date | null;
}

export interface RecipientStatsPageDto {
  campaignId: string;
  page: number;
  pageSize: number;
  total: number;
  items: RecipientStatDto[];
}

export interface ChannelBreakdownDto {
  primaryOnly: number;
  both: number;
  appIoOnly: number;
  appIoDespitePrimaryFail: number;
  neither: number;
  /** Destinatari con un dirottamento INAD reale (indirizzo trovato diverso da quello configurato). */
  inadDiverted: number;
}

/** Conteggio destinatari SENT per canale effettivo di consegna (chiavi = NotificationChannel osservati). */
export type EffectiveChannelBreakdownDto = Record<string, number>;

export interface DownloadCombinationDto {
  /** Canali da cui il destinatario ha scaricato (ordinati); [] = nessun download. */
  channels: string[];
  count: number;
  /**
   * true = destinatario notificato con successo (primario o App IO
   * co-consegna); false = ha scaricato pur non risultando notificato con
   * successo (es. portale con link ancora valido nonostante l'invio
   * fallito). Il denominatore delle percentuali lato UI è `sentCount`, non
   * il totale destinatari: mescolare i falliti (che non hanno mai avuto un
   * link da scaricare) nella stessa percentuale dei "non scaricato" era
   * fuorviante.
   */
  sentSuccessfully: boolean;
}

export interface DownloadCombinationStatsDto {
  /** Destinatari notificati con successo — denominatore delle percentuali di download. */
  sentCount: number;
  combinations: DownloadCombinationDto[];
}

export interface FailureRowDto {
  recipientId: string;
  codiceFiscale: string;
  fullName: string | null;
  errorMessage: string | null;
  attemptNumber: number;
  lastAttemptAt: string;
}

export interface FailureGroupDto {
  errorMessage: string;
  count: number;
  recipientIds: string[];
}

export interface RetryBulkResultDto {
  requeued: number;
  failed: Array<{ recipientId: string; reason: string }>;
}

export interface DownloadReportRowDto {
  codiceFiscale: string;
  fullName: string | null;
  email: string | null;
  pec: string | null;
  status: string;
  downloadCount: number;
  lastDownloadedAt: string | null;
}

export interface SendStatusBreakdownDto {
  /** null = attempt non ancora sincronizzato/IUN non risolto ("In attesa"). */
  status: string | null;
  count: number;
}

export interface SendReportRowDto {
  codiceFiscale: string;
  fullName: string | null;
  iun: string | null;
  digitalDomicileType: string | null;
  digitalDomicileAddress: string | null;
  sendStatus: string | null;
  sendStatusHistory: Array<{ status: string; activeFrom: string }>;
  /** null se la campagna non ha co-consegna App IO configurata. */
  appIoOutcome: { success: boolean; error: string | null } | null;
}

export interface SendReportDto {
  /** Determina se i CSV builder devono includere la colonna "Esito App IO". */
  hasAppIoCoDelivery: boolean;
  rows: SendReportRowDto[];
}

export interface PostalStatusBreakdownDto {
  /** null = attempt non ancora sincronizzato ("In corso"). */
  status: string | null;
  count: number;
}

export interface PostalReportRowDto {
  codiceFiscale: string;
  fullName: string | null;
  postalTrackingId: string | null;
  postalStatus: string | null;
  postalStatusHistory: Array<{ stato: string; rilevatoIl: string }>;
  codiceErrore: string | null;
  descrizioneErrore: string | null;
  /** null se la campagna non ha co-consegna App IO configurata. */
  appIoOutcome: { success: boolean; error: string | null } | null;
}

export interface PostalReportDto {
  /** Determina se i CSV builder devono includere la colonna "Esito App IO". */
  hasAppIoCoDelivery: boolean;
  rows: PostalReportRowDto[];
}
