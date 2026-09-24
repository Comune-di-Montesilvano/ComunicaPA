import { Injectable } from '@nestjs/common';
import { parsePosteResponse, PosteTrackingError, type PosteTrackingResponse } from './poste-tracking-mapping.util.js';

/**
 * Endpoint JSON pubblico (non documentato, nessuna autenticazione) usato
 * dalla pagina "Cerca spedizioni" di poste.it. Può cambiare senza
 * preavviso: ogni anomalia diventa PosteTrackingError, mai un esito.
 */
export const POSTE_TRACKING_URL = 'https://www.poste.it/online/dovequando/DQ-REST/ricercasemplice';
const TIMEOUT_MS = 15_000;

@Injectable()
export class PosteTrackingClient {
  async track(code: string): Promise<PosteTrackingResponse> {
    let res: Response;
    try {
      res = await fetch(POSTE_TRACKING_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'ComunicaPA/1.0 (verifica consegna raccomandate PA)',
        },
        body: JSON.stringify({ tipoRichiedente: 'WEB', codiceSpedizione: code, periodoRicerca: 1 }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new PosteTrackingError(`Errore di rete verso Poste: ${err instanceof Error ? err.message : String(err)}`, 'network');
    }
    if (!res.ok) throw new PosteTrackingError(`HTTP ${res.status} da Poste`, 'http');
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new PosteTrackingError('Risposta Poste non JSON', 'invalid_body');
    }
    return parsePosteResponse(body);
  }
}
