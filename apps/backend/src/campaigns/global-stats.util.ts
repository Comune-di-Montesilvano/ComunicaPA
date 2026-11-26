export interface MonthlySentRow {
  month: string;
  sent: string | number;
}

export interface MonthlyDownloadedRow {
  month: string;
  downloaded: string | number;
}

export interface MonthlyTrendPoint {
  month: string;
  sent: number;
  downloaded: number;
}

/**
 * Unisce due serie mensili (invii e download) in un'unica lista ordinata
 * cronologicamente, riempiendo con 0 i mesi presenti in una sola serie.
 */
export function mergeMonthlyTrend(
  sentRows: MonthlySentRow[],
  downloadedRows: MonthlyDownloadedRow[],
): MonthlyTrendPoint[] {
  const byMonth = new Map<string, MonthlyTrendPoint>();

  for (const row of sentRows) {
    byMonth.set(row.month, { month: row.month, sent: Number(row.sent), downloaded: 0 });
  }
  for (const row of downloadedRows) {
    const existing = byMonth.get(row.month);
    if (existing) {
      existing.downloaded = Number(row.downloaded);
    } else {
      byMonth.set(row.month, { month: row.month, sent: 0, downloaded: Number(row.downloaded) });
    }
  }

  return Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
}

export function computeDownloadPercentage(downloaded: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
}

export interface DateRangeWhere {
  sql: string;
  params: Record<string, string>;
}

/**
 * Costruisce la clausola WHERE per il filtro data su un alias di query
 * builder TypeORM. Ritorna '1=1' (nessun filtro) quando dateFrom/dateTo
 * sono entrambi assenti, per poter sempre passare il risultato a
 * qb.where(...)/qb.andWhere(...) senza controlli condizionali sparsi.
 */
export function buildDateRangeWhere(alias: string, dateFrom?: string, dateTo?: string, taxonomyCode?: string): DateRangeWhere {
  const clauses: string[] = [];
  const params: Record<string, string> = {};

  // Filtro tassonomia SEND (Statistiche): restringe anche il canale, così
  // i totali "per canale" e i costi Posta non mischiano campagne non SEND.
  if (taxonomyCode) {
    clauses.push(`${alias}.channelType = 'SEND'`);
    clauses.push(`(${alias}.channelConfig ->> 'taxonomyCode') = :taxonomyCode`);
    params.taxonomyCode = taxonomyCode;
  }

  if (dateFrom) {
    clauses.push(`${alias}.createdAt >= :dateFrom`);
    params.dateFrom = dateFrom;
  }
  if (dateTo) {
    clauses.push(`${alias}.createdAt < (:dateTo::date + interval '1 day')`);
    params.dateTo = dateTo;
  }

  return { sql: clauses.length > 0 ? clauses.join(' AND ') : '1=1', params };
}

/** Codice tassonomia SEND: 6 cifre + P (con pagamento) / N (senza). */
export const SEND_TAXONOMY_CODE_RE = /^\d{6}[PN]$/;

/**
 * Filtro `taxonomyCode` da query string: vuoto → nessun filtro, formato
 * non valido → null (il controller risponde 400), altrimenti il codice.
 */
export function parseTaxonomyFilter(raw?: string): string | undefined | null {
  const value = raw?.trim().toUpperCase();
  if (!value) return undefined;
  return SEND_TAXONOMY_CODE_RE.test(value) ? value : null;
}

export interface SendTaxonomyCountRow {
  taxonomyCode: string | null;
  campaigns: string | number;
  recipients: string | number;
  perfected: string | number;
  unreachable: string | number;
  failed: string | number;
  cancelled: string | number;
}

export interface SendTaxonomyCostRow {
  taxonomyCode: string | null;
  costCents: string | number | null;
}

export interface SendTaxonomyStatDto {
  /** null = campagne SEND senza tassonomia salvata (non dovrebbero esistere). */
  taxonomyCode: string | null;
  campaigns: number;
  recipients: number;
  /** Letta dal destinatario o perfezionata per decorrenza termini. */
  perfected: number;
  /** Ancora in corso: in coda, in validazione, accettata, in consegna, consegnata. */
  inProgress: number;
  /** Irreperibile o restituita al mittente. */
  unreachable: number;
  /** Invio fallito, compresi i rifiuti di SEND in validazione. */
  failed: number;
  /** Annullata (SEND o ComunicaPA) o saltata. */
  cancelled: number;
  costCents: number;
}

/**
 * Unisce conteggi ed esiti per tassonomia con i costi; "in corso" è il resto
 * dei destinatari (mai negativo). Ordinato per destinatari, poi per codice.
 */
export function buildSendTaxonomyStats(counts: SendTaxonomyCountRow[], costs: SendTaxonomyCostRow[]): SendTaxonomyStatDto[] {
  const costBy = new Map(costs.map((c) => [c.taxonomyCode ?? null, Number(c.costCents ?? 0)]));
  return counts
    .map((r) => {
      const recipients = Number(r.recipients);
      const perfected = Number(r.perfected);
      const unreachable = Number(r.unreachable);
      const failed = Number(r.failed);
      const cancelled = Number(r.cancelled);
      return {
        taxonomyCode: r.taxonomyCode ?? null,
        campaigns: Number(r.campaigns),
        recipients,
        perfected,
        inProgress: Math.max(0, recipients - perfected - unreachable - failed - cancelled),
        unreachable,
        failed,
        cancelled,
        costCents: costBy.get(r.taxonomyCode ?? null) ?? 0,
      };
    })
    .sort((a, b) => b.recipients - a.recipients || String(a.taxonomyCode ?? '~').localeCompare(String(b.taxonomyCode ?? '~')));
}
