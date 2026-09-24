/**
 * Aggregazione costi SEND/POSTAL per la vista Statistiche. Funzione pura:
 * riceve le righe attempt già filtrate (periodo, niente campagne di test)
 * e produce tutte le scomposizioni mostrate in UI.
 *
 * Tutti gli importi sono al NETTO IVA — POSTAL: costoNetto GlobalCom;
 * SEND: paFee + analogCost della timeline PN (PN espone l'IVA a parte).
 */

export interface CostAttemptRow {
  channelType: 'SEND' | 'POSTAL';
  status: string;
  costCents: number | null;
  costBreakdown: Record<string, unknown> | null;
  sendDigitalDomicile: { type?: string } | null;
  postalStatus: string | null;
  campaignId: string;
  campaignName: string;
  month: string;
}

export interface CostBucket {
  count: number;
  costCents: number;
}

export interface CostByKey extends CostBucket {
  key: string;
}

export interface CostAnalyticsDto {
  totalCostCents: number;
  send: {
    totalCostCents: number;
    digital: CostBucket;
    analog: CostBucket & { baseFeeCents: number; analogCostCents: number };
    /** Costo della sola parte cartacea, per prodotto PN (AR, 890, RS...). */
    byProduct: CostByKey[];
    pendingCount: number;
  };
  postal: {
    totalCostCents: number;
    count: number;
    avgCostCents: number;
    components: { stampaCents: number; postaleCents: number; arCents: number };
    byProduct: CostByKey[];
    domestic: CostBucket;
    foreign: CostBucket;
    pendingCount: number;
  };
  monthly: Array<{ month: string; sendDigitalCents: number; sendAnalogCents: number; postalCents: number }>;
  topCampaigns: Array<{ campaignId: string; campaignName: string; channelType: string; costCents: number; costedCount: number; avgCostCents: number }>;
  savings: {
    /** Notifiche SEND recapitate in digitale × costo medio spedizione cartacea evitata. */
    sendCents: number;
    sendDigitalCount: number;
    /** Digitali senza alcun cartaceo di riferimento (né in campagna né nel periodo): non stimabili. */
    sendNotEstimableCount: number;
    /** POSTAL dirottati su domicilio digitale × costo medio spedizione. */
    postalCents: number;
    postalDivertedCount: number;
    postalNotEstimableCount: number;
  };
}

type AnalogEvent = { productType?: string | null; analogCostCents?: number };

function analogEventsOf(row: CostAttemptRow): AnalogEvent[] {
  const events = row.costBreakdown?.['analogEvents'];
  return Array.isArray(events) ? (events as AnalogEvent[]) : [];
}

/** SEND analogico = PN ha spedito carta (evento con costo, o domicilio risolto CARTACEO). */
export function classifySendAttempt(row: CostAttemptRow): 'digital' | 'analog' {
  if (analogEventsOf(row).length > 0) return 'analog';
  return row.sendDigitalDomicile?.type === 'CARTACEO' ? 'analog' : 'digital';
}

function eurosToCents(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : 0;
}

function addTo(map: Map<string, CostBucket>, key: string, costCents: number): void {
  const b = map.get(key) ?? { count: 0, costCents: 0 };
  b.count += 1;
  b.costCents += costCents;
  map.set(key, b);
}

function sortedByCost(map: Map<string, CostBucket>): CostByKey[] {
  return [...map.entries()]
    .map(([key, b]) => ({ key, ...b }))
    .sort((a, b) => b.costCents - a.costCents || a.key.localeCompare(b.key));
}

export function buildCostAnalytics(
  rows: CostAttemptRow[],
  opts: { postalDivertedByCampaign: Record<string, number> },
): CostAnalyticsDto {
  const digital: CostBucket = { count: 0, costCents: 0 };
  const analog = { count: 0, costCents: 0, baseFeeCents: 0, analogCostCents: 0 };
  const sendProducts = new Map<string, CostBucket>();
  let sendPending = 0;

  const postal = { count: 0, costCents: 0 };
  const components = { stampaCents: 0, postaleCents: 0, arCents: 0 };
  const postalProducts = new Map<string, CostBucket>();
  const domestic: CostBucket = { count: 0, costCents: 0 };
  const foreign: CostBucket = { count: 0, costCents: 0 };
  let postalPending = 0;

  const monthly = new Map<string, { month: string; sendDigitalCents: number; sendAnalogCents: number; postalCents: number }>();
  const campaigns = new Map<string, { campaignId: string; campaignName: string; channelType: string; costCents: number; costedCount: number }>();
  // Per la stima risparmio, medie PER CAMPAGNA (stesso tributo/formato/grammatura)
  // con fallback sulla media del periodo solo se la campagna non ha riferimenti.
  const sendByCampaign = new Map<string, { digital: number; analog: number; shipCents: number }>();
  const postalByCampaign = new Map<string, { count: number; costCents: number }>();

  for (const row of rows) {
    // Mai spedito a GlobalCom (App IO esclusiva): nessun costo né in arrivo.
    if (row.postalStatus === 'AppIoSostituito') continue;
    // cost_cents 0 = placeholder GlobalCom "ancora in lavorazione", come NULL.
    const notYetCosted = row.costCents === null || row.costCents === 0;
    if (notYetCosted) {
      if (row.status === 'success') {
        if (row.channelType === 'SEND') sendPending += 1;
        else postalPending += 1;
      }
      continue;
    }
    const cost = row.costCents as number;

    const m = monthly.get(row.month) ?? { month: row.month, sendDigitalCents: 0, sendAnalogCents: 0, postalCents: 0 };
    const c = campaigns.get(row.campaignId) ?? { campaignId: row.campaignId, campaignName: row.campaignName, channelType: row.channelType, costCents: 0, costedCount: 0 };
    c.costCents += cost;
    c.costedCount += 1;
    campaigns.set(row.campaignId, c);

    if (row.channelType === 'SEND') {
      if (classifySendAttempt(row) === 'analog') {
        const events = analogEventsOf(row);
        const analogPart = events.reduce((s, e) => s + (e.analogCostCents ?? 0), 0);
        analog.count += 1;
        analog.costCents += cost;
        analog.analogCostCents += analogPart;
        analog.baseFeeCents += cost - analogPart;
        for (const e of events) addTo(sendProducts, e.productType || 'N/D', e.analogCostCents ?? 0);
        m.sendAnalogCents += cost;
        const sc = sendByCampaign.get(row.campaignId) ?? { digital: 0, analog: 0, shipCents: 0 };
        sc.analog += 1;
        sc.shipCents += analogPart;
        sendByCampaign.set(row.campaignId, sc);
      } else {
        digital.count += 1;
        digital.costCents += cost;
        m.sendDigitalCents += cost;
        const sc = sendByCampaign.get(row.campaignId) ?? { digital: 0, analog: 0, shipCents: 0 };
        sc.digital += 1;
        sendByCampaign.set(row.campaignId, sc);
      }
    } else {
      const b = row.costBreakdown ?? {};
      postal.count += 1;
      postal.costCents += cost;
      components.stampaCents += eurosToCents(b['importoStampaNetto']);
      components.postaleCents += eurosToCents(b['importoPostaleNetto']);
      components.arCents += eurosToCents(b['importoARNetto']);
      addTo(postalProducts, typeof b['tipoDocumento'] === 'string' ? (b['tipoDocumento'] as string) : 'N/D', cost);
      const target = b['nazionale'] === false ? foreign : domestic;
      target.count += 1;
      target.costCents += cost;
      m.postalCents += cost;
      const pc = postalByCampaign.get(row.campaignId) ?? { count: 0, costCents: 0 };
      pc.count += 1;
      pc.costCents += cost;
      postalByCampaign.set(row.campaignId, pc);
    }
    monthly.set(row.month, m);
  }

  const avgPostal = postal.count > 0 ? Math.round(postal.costCents / postal.count) : 0;
  const sendTotal = digital.costCents + analog.costCents;

  // Risparmio SEND: una notifica recapitata in digitale evita la spedizione
  // cartacea (es. 1€ notifica + 5,40€ raccomandata → risparmio 5,40€). La
  // base fee PN si paga comunque, quindi resta fuori dal risparmio.
  const periodShipAvg = analog.count > 0 ? analog.analogCostCents / analog.count : null;
  let sendSaving = 0;
  let sendNotEstimable = 0;
  for (const c of sendByCampaign.values()) {
    if (c.digital === 0) continue;
    const ref = c.analog > 0 ? c.shipCents / c.analog : periodShipAvg;
    if (ref === null) sendNotEstimable += c.digital;
    else sendSaving += c.digital * ref;
  }

  // Risparmio POSTAL: lettera dirottata su domicilio digitale = spedizione evitata.
  const periodPostalAvg = postal.count > 0 ? postal.costCents / postal.count : null;
  let postalSaving = 0;
  let postalDiverted = 0;
  let postalNotEstimable = 0;
  for (const [campaignId, diverted] of Object.entries(opts.postalDivertedByCampaign)) {
    if (!diverted) continue;
    postalDiverted += diverted;
    const pc = postalByCampaign.get(campaignId);
    const ref = pc && pc.count > 0 ? pc.costCents / pc.count : periodPostalAvg;
    if (ref === null) postalNotEstimable += diverted;
    else postalSaving += diverted * ref;
  }

  return {
    totalCostCents: sendTotal + postal.costCents,
    send: {
      totalCostCents: sendTotal,
      digital,
      analog,
      byProduct: sortedByCost(sendProducts),
      pendingCount: sendPending,
    },
    postal: {
      totalCostCents: postal.costCents,
      count: postal.count,
      avgCostCents: avgPostal,
      components,
      byProduct: sortedByCost(postalProducts),
      domestic,
      foreign,
      pendingCount: postalPending,
    },
    monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)),
    topCampaigns: [...campaigns.values()]
      .map((c) => ({ ...c, avgCostCents: Math.round(c.costCents / c.costedCount) }))
      .sort((a, b) => b.costCents - a.costCents || a.campaignName.localeCompare(b.campaignName, 'it'))
      .slice(0, 5),
    savings: {
      sendCents: Math.round(sendSaving),
      sendDigitalCount: digital.count,
      sendNotEstimableCount: sendNotEstimable,
      postalCents: Math.round(postalSaving),
      postalDivertedCount: postalDiverted,
      postalNotEstimableCount: postalNotEstimable,
    },
  };
}
