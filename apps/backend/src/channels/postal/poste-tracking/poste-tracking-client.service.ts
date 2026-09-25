import { Injectable } from '@nestjs/common';
import { parsePosteResponse, PosteTrackingError, type PosteTrackingResponse } from './poste-tracking-mapping.util.js';

/**
 * Endpoint JSON pubblici (non documentati, nessuna autenticazione) usati
 * dalla pagina "Cerca spedizioni" di poste.it. Può cambiare senza
 * preavviso: ogni anomalia diventa PosteTrackingError, mai un esito.
 *
 * Stesso flusso del sito, mai la sola ricerca: prima `verificaricercasemplice`,
 * poi `ricercasemplice` con i cookie della verifica. Senza verifica Poste
 * risponde con dati ridotti (esitoRicerca "2" o stato "1" senza movimenti,
 * niente fase 6 / flagRitorno / sintesiStato) — bug reale: restituzioni al
 * mittente viste come "in verifica" o "consegnate".
 */
export const POSTE_VERIFY_URL = 'https://www.poste.it/online/dovequando/DQ-REST/verificaricercasemplice';
export const POSTE_TRACKING_URL = 'https://www.poste.it/online/dovequando/DQ-REST/ricercasemplice';
const REFERER = 'https://www.poste.it/cerca-spedizioni/index.html';
const TIMEOUT_MS = 15_000;
const BASE_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://www.poste.it',
  Referer: REFERER,
  'User-Agent': 'ComunicaPA/1.0 (verifica consegna raccomandate PA)',
};

function cookieHeader(res: Response): string {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ?? '').split(/,(?=\s*[^;=]+=)/);
  return raw.map((c) => c.split(';')[0]!.trim()).filter(Boolean).join('; ');
}

function httpError(res: Response): PosteTrackingError {
  // Poste risponde 400 (non 429) quando limita le richieste ravvicinate
  // dallo stesso IP (visto in produzione dopo ~20 chiamate a 2 s): ogni
  // 4xx è trattato come blocco, mai come esito del codice.
  return new PosteTrackingError(`HTTP ${res.status} da Poste`, res.status >= 400 && res.status < 500 ? 'blocked' : 'http');
}

@Injectable()
export class PosteTrackingClient {
  private async post(url: string, body: unknown, cookie?: string): Promise<Response> {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: cookie ? { ...BASE_HEADERS, Cookie: cookie } : { ...BASE_HEADERS },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new PosteTrackingError(`Errore di rete verso Poste: ${err instanceof Error ? err.message : String(err)}`, 'network');
    }
  }

  async track(code: string): Promise<PosteTrackingResponse> {
    const verify = await this.post(POSTE_VERIFY_URL, { codiceSpedizione: code, tipoRichiedente: 'WEB' });
    if (!verify.ok) throw httpError(verify);
    const cookie = cookieHeader(verify);

    const res = await this.post(POSTE_TRACKING_URL, { tipoRichiedente: 'WEB', codiceSpedizione: code, periodoRicerca: 1 }, cookie || undefined);
    if (!res.ok) throw httpError(res);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new PosteTrackingError('Risposta Poste non JSON', 'invalid_body');
    }
    return parsePosteResponse(body);
  }
}
