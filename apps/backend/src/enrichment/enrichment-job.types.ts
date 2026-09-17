export const ENRICHMENT_QUEUE = 'enrichment-jobs';

export interface EnrichmentQueueJobData {
  jobId: string;
}

/**
 * Coda separata da ENRICHMENT_QUEUE: leggere/copiare file già finalizzati
 * di un EnrichmentJob DONE (nessuna PDF extraction, nessun adm-zip) non deve
 * mai aspettare un enrichment pesante in corso su un job diverso — bug reale:
 * "crea bozza campagna" restava in coda finché un job indipendente non finiva
 * (worker unico, concurrency di default 1, stessa coda per entrambi).
 */
export const CONVERT_CAMPAIGN_QUEUE = 'enrichment-convert-campaign-jobs';

export const CONVERT_CAMPAIGN_JOB_NAME = 'convert-campaign';

export interface ConvertCampaignQueueJobData {
  jobId: string;
  name: string;
  channelType: 'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL';
  createdBy: string;
  /** Separa i destinatari senza dati PagoPa (numero_avviso/importo/scadenza tutte vuote) in una seconda bozza campagna dedicata. */
  splitMissingPayment?: boolean;
}

/**
 * Stessa coda/stesso EnrichmentQueueJobData di 'enrich' (solo jobId) — mai
 * su una coda separata: la concurrency=1 di ENRICHMENT_QUEUE è qui una
 * garanzia voluta, non un limite da aggirare. Se il job 'enrich' originale
 * è ancora davvero active, questo job aspetta semplicemente il suo turno
 * (nessun secondo writer concorrente sul checkpoint); se il worker è morto
 * (redeploy), lo stalled-job recovery di BullMQ libera lo slot entro
 * ~stalledInterval prima che questo parta. Introdotto perché il retry
 * sincrono dentro l'handler HTTP (1142 righe, una chiamata pdf-extractor
 * ciascuna) superava il timeout del reverse proxy esterno (504) — stesso
 * principio "lavoro pesante mai dentro la richiesta HTTP" già in vigore per
 * "crea bozza campagna".
 */
export const RETRY_FAILED_PDFS_JOB_NAME = 'retry-failed-pdfs';

export const MERGE_BATCH_JOB_NAME = 'merge-batch';

export interface MergeBatchQueueJobData {
  jobId: string;
  batchId: string;
  zipPaths: string[];
  zipFilenames: string[];
}
