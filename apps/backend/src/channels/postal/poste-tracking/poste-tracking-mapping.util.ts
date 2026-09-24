import type { PosteTrackingMovement } from '../../../entities/postal-poste-tracking.entity.js';

export class PosteTrackingError extends Error {
  constructor(message: string, readonly kind: 'network' | 'http' | 'invalid_body') {
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
      at: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '',
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
export function mapPosteOutcome(r: PosteTrackingResponse): { outcome: PosteOutcome; deliveredAt: Date | null } {
  if (r.flagRitorno || r.movements.some((m) => m.flagRitorno)) return { outcome: 'returned', deliveredAt: null };
  if (r.esitoRicerca === '3' && r.stato === '5') {
    const last = lastMovement(r.movements);
    return { outcome: 'delivered', deliveredAt: last?.at ? new Date(last.at) : null };
  }
  return { outcome: 'pending', deliveredAt: null };
}
