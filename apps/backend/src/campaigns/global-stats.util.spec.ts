import { mergeMonthlyTrend, computeDownloadPercentage, buildDateRangeWhere, parseTaxonomyFilter, buildSendTaxonomyStats } from './global-stats.util.js';

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

describe('buildDateRangeWhere con tassonomia SEND', () => {
  it('aggiunge canale SEND e codice tassonomia insieme alle date', () => {
    expect(buildDateRangeWhere('c', '2026-06-01', undefined, '010201P')).toEqual({
      sql: "c.channelType = 'SEND' AND (c.channelConfig ->> 'taxonomyCode') = :taxonomyCode AND c.createdAt >= :dateFrom",
      params: { taxonomyCode: '010201P', dateFrom: '2026-06-01' },
    });
  });
});

describe('parseTaxonomyFilter', () => {
  it('vuoto = nessun filtro, valido = codice maiuscolo, non valido = null', () => {
    expect(parseTaxonomyFilter(undefined)).toBeUndefined();
    expect(parseTaxonomyFilter('  ')).toBeUndefined();
    expect(parseTaxonomyFilter(' 010201p ')).toBe('010201P');
    expect(parseTaxonomyFilter("010201P' OR 1=1")).toBeNull();
    expect(parseTaxonomyFilter('01020P')).toBeNull();
  });
});

describe('buildSendTaxonomyStats', () => {
  it('calcola "in corso" come resto, unisce i costi e ordina per destinatari', () => {
    const result = buildSendTaxonomyStats(
      [
        { taxonomyCode: '010101P', campaigns: '1', recipients: '3', perfected: '1', unreachable: '0', failed: '1', cancelled: '0' },
        { taxonomyCode: '010201P', campaigns: '2', recipients: '10', perfected: '4', unreachable: '1', failed: '2', cancelled: '1' },
        { taxonomyCode: null, campaigns: '1', recipients: '1', perfected: '0', unreachable: '0', failed: '1', cancelled: '1' },
      ],
      [{ taxonomyCode: '010201P', costCents: '1234' }],
    );
    expect(result.map((r) => r.taxonomyCode)).toEqual(['010201P', '010101P', null]);
    expect(result[0]).toEqual({
      taxonomyCode: '010201P', campaigns: 2, recipients: 10, perfected: 4, inProgress: 2,
      unreachable: 1, failed: 2, cancelled: 1, costCents: 1234,
    });
    expect(result[1].costCents).toBe(0);
    expect(result[2].inProgress).toBe(0);
  });
});
