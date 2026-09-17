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

export const MERGE_BATCH_JOB_NAME = 'merge-batch';

export interface MergeBatchQueueJobData {
  jobId: string;
  batchId: string;
  zipPaths: string[];
  zipFilenames: string[];
}
