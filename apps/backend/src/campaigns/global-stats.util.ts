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
  return total > 0 ? Math.round((downloaded / total) * 100) : 0;
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
export function buildDateRangeWhere(alias: string, dateFrom?: string, dateTo?: string): DateRangeWhere {
  const clauses: string[] = [];
  const params: Record<string, string> = {};

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
