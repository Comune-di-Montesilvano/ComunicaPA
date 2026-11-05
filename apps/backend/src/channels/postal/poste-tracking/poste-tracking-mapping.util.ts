import type { PosteTrackingMovement } from '../../../entities/postal-poste-tracking.entity.js';

export class PosteTrackingError extends Error {
  constructor(message: string, readonly kind: 'network' | 'http' | 'blocked' | 'invalid_body') {
    super(message);
    this.name = 'PosteTrackingError';
  }
}

export interface PosteTrackingResponse {
  esitoRicerca: string;
  stato: string;
  flagRitorno: boolean;
  tipoProdotto: string | null;
  movements: PosteTrackingMovement[];
  raw: Record<string, unknown>;
}

export type PosteOutcome = 'delivered' | 'returned' | 'pending';

function romeOffsetMs(instant: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(instant / 1000) * 1000;
}

/**
 * `dataOra` di poste.it è l'ora italiana codificata come se fosse UTC
 * (verificato dal vivo: "consegnata" 11:20:24Z quando SEND registra lo stesso
 * esito alle 09:20Z, e "in consegna" 10:34Z contro RECRN010 alle 08:34Z,
 * sempre +2 h in ora legale). Si leggono i campi UTC come ora di Roma.
 */
export function posteDataOraToDate(ms: number): Date {
  const guess = ms - romeOffsetMs(ms);
  return new Date(ms - romeOffsetMs(guess));
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/**
 * Risposta dell'endpoint JSON (non documentato) dietro "Cerca spedizioni"
 * di poste.it. Qualunque cosa che non sia un oggetto con `esitoRicerca` è
 * trattata come formato cambiato/pagina di errore → invalid_body (mai un
 * esito: il chiamante non consuma il controllo).
 */
export function parsePosteResponse(body: unknown): PosteTrackingResponse {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('esitoRicerca' in body)) {
    throw new PosteTrackingError('Risposta Poste in formato inatteso', 'invalid_body');
  }
  const b = body as Record<string, unknown>;
  const lista = Array.isArray(b['listaMovimenti']) ? (b['listaMovimenti'] as Array<Record<string, unknown>>) : [];
  const movements: PosteTrackingMovement[] = lista.map((m) => {
    const ms = Number(m['dataOra']);
    return {
      at: Number.isFinite(ms) && ms > 0 ? posteDataOraToDate(ms).toISOString() : '',
      luogo: str(m['luogo']),
      statoLavorazione: str(m['statoLavorazione']),
      box: str(m['box']),
      flagRitorno: m['flagRitorno'] === true,
    };
  });
  return {
    esitoRicerca: str(b['esitoRicerca']),
    stato: str(b['stato']),
    flagRitorno: b['flagRitorno'] === true,
    tipoProdotto: b['tipoProdotto'] ? str(b['tipoProdotto']) : null,
    movements,
    raw: b,
  };
}

/** Movimento con `box` (fase) più alto; a parità il più recente. */
export function lastMovement(movements: PosteTrackingMovement[]): PosteTrackingMovement | null {
  let best: PosteTrackingMovement | null = null;
  for (const m of movements) {
    if (!best) { best = m; continue; }
    const diff = (Number(m.box) || 0) - (Number(best.box) || 0);
    if (diff > 0 || (diff === 0 && m.at > best.at)) best = m;
  }
  return best;
}

/**
 * Mappatura prudente: solo `stato "5"` è verificato su un caso reale come
 * "consegnata". Il ritorno al mittente ha la precedenza (una consegna "con
 * successo" dopo il ritorno è al mittente, non al destinatario). Tutto il
 * resto resta pending, con risposta grezza salvata per allargare la
 * mappatura sui casi reali.
 */
/** Dove doveva arrivare la lettera e chi la spedisce: serve a riconoscere i ritorni. */
export interface DeliveryContext {
  recipientForeign?: boolean;
  recipientCity?: string | null;
  senderCity?: string | null;
}

function normCity(s: string): string {
  return s.toUpperCase().replace(/\([^)]*\)/g, ' ').replace(/[^A-Z]+/g, ' ').trim();
}

/**
 * Poste non sempre segna flagRitorno: una raccomandata restituita può
 * chiudersi con "consegnata" (fase 5) all'ufficio del mittente. Caso reale
 * (raccomandata internazionale per l'Austria, KO GlobalCom "indirizzo
 * errato"): movimenti solo italiani, consegnata a MONTESILVANO (PE) = il
 * Comune mittente. Due segnali: destinatario estero ma consegna con sigla di
 * provincia italiana "(XX)"; oppure consegna nella città del mittente con
 * destinatario altrove (se la città coincide, non distinguibile).
 */
export function isDeliveryToSender(luogo: string, ctx: DeliveryContext): boolean {
  if (!luogo) return false;
  if (ctx.recipientForeign && /\([A-Z]{2}\)/.test(luogo.toUpperCase())) return true;
  if (!ctx.senderCity) return false;
  const sender = normCity(ctx.senderCity);
  if (!sender || !` ${normCity(luogo)} `.includes(` ${sender} `)) return false;
  return !ctx.recipientCity || normCity(ctx.recipientCity) !== sender;
}

export function mapPosteOutcome(r: PosteTrackingResponse, ctx?: DeliveryContext): { outcome: PosteOutcome; outcomeAt: Date | null } {
  // Data esito = data dell'ultimo movimento Poste (consegna o ritorno):
  // dato che l'ente usa come data di consegna/mancata consegna.
  const last = lastMovement(r.movements);
  const outcomeAt = last?.at ? new Date(last.at) : null;
  if (r.flagRitorno || r.movements.some((m) => m.flagRitorno)) return { outcome: 'returned', outcomeAt };
  if (r.esitoRicerca === '3' && r.stato === '5') {
    if (ctx && last && isDeliveryToSender(last.luogo, ctx)) return { outcome: 'returned', outcomeAt };
    return { outcome: 'delivered', outcomeAt };
  }
  return { outcome: 'pending', outcomeAt: null };
}
