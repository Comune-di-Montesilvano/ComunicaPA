import { buildCostAnalytics, classifySendAttempt, type CostAttemptRow } from './cost-analytics.util.js';

function sendRow(over: Partial<CostAttemptRow> = {}): CostAttemptRow {
  return {
    channelType: 'SEND',
    status: 'success',
    costCents: 100,
    costBreakdown: { baseFeeCents: 100, analogEvents: [] },
    sendDigitalDomicile: { type: 'PEC' },
    postalStatus: null,
    campaignId: 'c-send',
    campaignName: 'TARI SEND',
    month: '2026-09',
    ...over,
  };
}

function postalRow(over: Partial<CostAttemptRow> = {}): CostAttemptRow {
  return {
    channelType: 'POSTAL',
    status: 'success',
    costCents: 87,
    costBreakdown: { nazionale: true, costoNetto: 0.87, tipoDocumento: 'LetteraContest4', importoStampaNetto: 0.22, importoPostaleNetto: 0.65, importoARNetto: 0 },
    sendDigitalDomicile: null,
    postalStatus: 'Confermato',
    campaignId: 'c-postal',
    campaignName: 'Solleciti',
    month: '2026-08',
    ...over,
  };
}

describe('classifySendAttempt', () => {
  it('digitale se nessun evento cartaceo e domicilio non CARTACEO', () => {
    expect(classifySendAttempt(sendRow())).toBe('digital');
  });

  it('analogico se il breakdown ha eventi cartacei', () => {
    expect(classifySendAttempt(sendRow({ costBreakdown: { baseFeeCents: 100, analogEvents: [{ productType: 'AR', analogCostCents: 493 }] } }))).toBe('analog');
  });

  it('analogico se il domicilio risolto da PN è CARTACEO anche col breakdown ancora vuoto', () => {
    expect(classifySendAttempt(sendRow({ sendDigitalDomicile: { type: 'CARTACEO' } }))).toBe('analog');
  });
});

describe('buildCostAnalytics', () => {
  it('separa SEND digitali/analogici, scompone POSTAL e somma il totale', () => {
    const result = buildCostAnalytics(
      [
        sendRow(),
        sendRow({ costCents: 593, costBreakdown: { baseFeeCents: 100, analogEvents: [{ productType: 'AR', analogCostCents: 493 }] } }),
        sendRow({ costCents: 540, costBreakdown: { baseFeeCents: 100, analogEvents: [{ productType: '890', analogCostCents: 440 }] } }),
        postalRow(),
        postalRow({ costCents: 516, costBreakdown: { nazionale: false, tipoDocumento: 'RaccomandataMarket4', importoStampaNetto: 0.3, importoPostaleNetto: 4.26, importoARNetto: 0.6 } }),
      ],
      { postalDivertedByCampaign: {} },
    );

    expect(result.totalCostCents).toBe(100 + 593 + 540 + 87 + 516);
    expect(result.send.digital).toEqual({ count: 1, costCents: 100 });
    expect(result.send.analog).toEqual({ count: 2, costCents: 1133, baseFeeCents: 200, analogCostCents: 933 });
    expect(result.send.byProduct).toEqual([
      { key: 'AR', count: 1, costCents: 493 },
      { key: '890', count: 1, costCents: 440 },
    ]);
    expect(result.postal.count).toBe(2);
    expect(result.postal.components).toEqual({ stampaCents: 52, postaleCents: 491, arCents: 60 });
    expect(result.postal.domestic).toEqual({ count: 1, costCents: 87 });
    expect(result.postal.foreign).toEqual({ count: 1, costCents: 516 });
    expect(result.postal.byProduct.map((p) => p.key)).toEqual(['RaccomandataMarket4', 'LetteraContest4']);
  });

  it('conta come "da calcolare" i costi null/0 degli invii riusciti, mai falliti né sostituiti da App IO', () => {
    const result = buildCostAnalytics(
      [
        sendRow({ costCents: null }),
        postalRow({ costCents: 0 }),
        postalRow({ costCents: null, status: 'failed' }),
        postalRow({ costCents: null, postalStatus: 'AppIoSostituito' }),
      ],
      { postalDivertedByCampaign: {} },
    );

    expect(result.send.pendingCount).toBe(1);
    expect(result.postal.pendingCount).toBe(1);
    expect(result.totalCostCents).toBe(0);
  });

  it('trend mensile ordinato per mese', () => {
    const result = buildCostAnalytics(
      [postalRow({ month: '2026-09', costCents: 100 }), postalRow({ month: '2026-08', costCents: 300 }), sendRow({ month: '2026-09' })],
      { postalDivertedByCampaign: {} },
    );

    expect(result.monthly).toEqual([
      { month: '2026-08', sendDigitalCents: 0, sendAnalogCents: 0, postalCents: 300 },
      { month: '2026-09', sendDigitalCents: 100, sendAnalogCents: 0, postalCents: 100 },
    ]);
    expect(result.postal.avgCostCents).toBe(200);
  });

  it('risparmio SEND: digitali × spedizione cartacea media DELLA CAMPAGNA (base fee esclusa), fallback media periodo', () => {
    const analog = (campaignId: string, ship: number) => sendRow({
      campaignId,
      costCents: 100 + ship,
      costBreakdown: { baseFeeCents: 100, analogEvents: [{ productType: 'AR', analogCostCents: ship }] },
    });
    const result = buildCostAnalytics(
      [
        // Campagna A: 2 digitali, cartaceo medio (500+580)/2 = 540 → 1080
        sendRow({ campaignId: 'A' }), sendRow({ campaignId: 'A' }), analog('A', 500), analog('A', 580),
        // Campagna B: 1 digitale, nessun cartaceo → media periodo (500+580+900)/3 = 660
        sendRow({ campaignId: 'B' }),
        analog('C', 900),
      ],
      { postalDivertedByCampaign: {} },
    );

    expect(result.savings.sendCents).toBe(1080 + 660);
    expect(result.savings.sendDigitalCount).toBe(3);
    expect(result.savings.sendNotEstimableCount).toBe(0);
  });

  it('risparmio SEND non stimabile se nel periodo non esiste alcun cartaceo di riferimento', () => {
    const result = buildCostAnalytics([sendRow(), sendRow()], { postalDivertedByCampaign: {} });

    expect(result.savings.sendCents).toBe(0);
    expect(result.savings.sendNotEstimableCount).toBe(2);
  });

  it('risparmio POSTAL: dirottati × costo medio DELLA CAMPAGNA, fallback media periodo', () => {
    const result = buildCostAnalytics(
      [
        postalRow({ campaignId: 'P1', costCents: 400 }), postalRow({ campaignId: 'P1', costCents: 600 }),
        postalRow({ campaignId: 'P2', costCents: 100 }),
      ],
      // P1: 2 × 500 = 1000 · P3 senza spedizioni proprie: 1 × media periodo 1100/3
      { postalDivertedByCampaign: { P1: 2, P3: 1 } },
    );

    expect(result.savings.postalCents).toBe(Math.round(1000 + 1100 / 3));
    expect(result.savings.postalDivertedCount).toBe(3);
    expect(result.savings.postalNotEstimableCount).toBe(0);
  });

  it('classifica campagne per costo decrescente con media per invio, max 5', () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => postalRow({ campaignId: `c${i}`, campaignName: `Camp ${i}`, costCents: 100 * (i + 1) })),
      postalRow({ campaignId: 'c5', campaignName: 'Camp 5', costCents: 400 }),
    ];
    const result = buildCostAnalytics(rows, { postalDivertedByCampaign: {} });

    expect(result.topCampaigns).toHaveLength(5);
    expect(result.topCampaigns[0]).toEqual({ campaignId: 'c5', campaignName: 'Camp 5', channelType: 'POSTAL', costCents: 1000, costedCount: 2, avgCostCents: 500 });
  });
});
