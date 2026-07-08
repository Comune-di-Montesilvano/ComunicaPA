import { mergeMonthlyTrend, computeDownloadPercentage, buildDateRangeWhere } from './global-stats.util';

describe('mergeMonthlyTrend', () => {
  it('unisce mesi con invii e download coincidenti', () => {
    const result = mergeMonthlyTrend(
      [{ month: '2026-06', sent: '50' }, { month: '2026-07', sent: '40' }],
      [{ month: '2026-06', downloaded: '30' }],
    );
    expect(result).toEqual([
      { month: '2026-06', sent: 50, downloaded: 30 },
      { month: '2026-07', sent: 40, downloaded: 0 },
    ]);
  });

  it('include un mese presente solo nei download (nessun invio quel mese)', () => {
    const result = mergeMonthlyTrend(
      [{ month: '2026-06', sent: '10' }],
      [{ month: '2026-07', downloaded: '5' }],
    );
    expect(result).toEqual([
      { month: '2026-06', sent: 10, downloaded: 0 },
      { month: '2026-07', sent: 0, downloaded: 5 },
    ]);
  });

  it('ordina i mesi cronologicamente indipendentemente dall\'ordine di input', () => {
    const result = mergeMonthlyTrend(
      [{ month: '2026-07', sent: '1' }, { month: '2026-06', sent: '2' }],
      [],
    );
    expect(result.map((r) => r.month)).toEqual(['2026-06', '2026-07']);
  });

  it('ritorna array vuoto con input vuoti', () => {
    expect(mergeMonthlyTrend([], [])).toEqual([]);
  });
});

describe('computeDownloadPercentage', () => {
  it('arrotonda la percentuale', () => {
    expect(computeDownloadPercentage(1, 3)).toBe(33);
  });

  it('ritorna 0 quando il totale è zero (nessuna divisione per zero)', () => {
    expect(computeDownloadPercentage(0, 0)).toBe(0);
  });
});

describe('buildDateRangeWhere', () => {
  it('ritorna 1=1 senza parametri quando nessuna data è fornita', () => {
    expect(buildDateRangeWhere('c')).toEqual({ sql: '1=1', params: {} });
  });

  it('applica solo dateFrom quando dateTo è assente', () => {
    expect(buildDateRangeWhere('c', '2026-06-01')).toEqual({
      sql: 'c.createdAt >= :dateFrom',
      params: { dateFrom: '2026-06-01' },
    });
  });

  it('applica solo dateTo quando dateFrom è assente', () => {
    expect(buildDateRangeWhere('c', undefined, '2026-07-08')).toEqual({
      sql: "c.createdAt < (:dateTo::date + interval '1 day')",
      params: { dateTo: '2026-07-08' },
    });
  });

  it('applica entrambi i filtri con AND', () => {
    expect(buildDateRangeWhere('c', '2026-06-01', '2026-07-08')).toEqual({
      sql: "c.createdAt >= :dateFrom AND c.createdAt < (:dateTo::date + interval '1 day')",
      params: { dateFrom: '2026-06-01', dateTo: '2026-07-08' },
    });
  });
});
