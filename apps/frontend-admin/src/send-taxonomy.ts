import { SEND_TAXONOMY_CATALOG } from '@comunicapa/shared-types';

const TITLE_BY_CODE = new Map(SEND_TAXONOMY_CATALOG.map((t) => [t.code, t.title]));

/**
 * Etichetta di una tassonomia SEND per Statistiche e Ricerca Notifiche:
 * "010201P · Notifiche Riscossione Tributi con pagamento". Il codice resta
 * sempre visibile: nel catalogo PN titoli uguali hanno varianti P/N.
 * null = campagna SEND senza tassonomia salvata.
 */
export function sendTaxonomyLabel(code: string | null | undefined): string {
  if (!code) return 'Tassonomia non indicata';
  const title = TITLE_BY_CODE.get(code);
  return title ? `${code} · ${title}` : code;
}

/** Riga di GET campaigns/stats/send-taxonomy (SendTaxonomyStatDto backend). */
export interface SendTaxonomyStat {
  taxonomyCode: string | null;
  campaigns: number;
  recipients: number;
  perfected: number;
  inProgress: number;
  unreachable: number;
  failed: number;
  cancelled: number;
  costCents: number;
}

/** Opzioni del filtro: solo tassonomie con un codice (mai la riga "non indicata"), ordinate per codice. */
export function sendTaxonomyOptions(rows: SendTaxonomyStat[]): Array<{ code: string; label: string }> {
  return rows
    .filter((r): r is SendTaxonomyStat & { taxonomyCode: string } => !!r.taxonomyCode)
    .map((r) => ({ code: r.taxonomyCode, label: sendTaxonomyLabel(r.taxonomyCode) }))
    .sort((a, b) => a.code.localeCompare(b.code));
}
