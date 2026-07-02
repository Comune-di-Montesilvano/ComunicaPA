/**
 * Assertion di sicurezza da eseguire al boot dell'applicazione.
 *
 * Il segreto usato per firmare i link di download pubblici (HMAC) protegge l'endpoint
 * NON autenticato `GET /public/download/:recipientId`, che serve PDF con dati personali.
 * Se in un deployment non-development il segreto è ancora il default di sviluppo, ogni
 * link diventa forgeabile: rifiutiamo l'avvio con un errore esplicito.
 */

export const DEFAULT_DOWNLOAD_LINK_SECRET = 'change-me-in-production';

export function assertProductionSecrets(nodeEnv: string, downloadLinkSecret: string): void {
  if (nodeEnv !== 'development' && downloadLinkSecret === DEFAULT_DOWNLOAD_LINK_SECRET) {
    throw new Error(
      `DOWNLOAD_LINK_SECRET non è impostato (usa ancora il default '${DEFAULT_DOWNLOAD_LINK_SECRET}'). ` +
        `Impostare una variabile d'ambiente DOWNLOAD_LINK_SECRET robusta e casuale prima di avviare ` +
        `in ambiente '${nodeEnv}': i link di download pubblici sarebbero altrimenti forgeabili da chiunque.`,
    );
  }
}
