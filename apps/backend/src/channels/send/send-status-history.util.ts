export interface SendStatusHistoryEntry {
  status: string;
  activeFrom: string;
}

export interface SendDigitalDomicile {
  type: string;
  address: string | null;
  source: string;
}

/**
 * Copia diretta di notificationStatusHistory da PN (già completo e
 * ordinato cronologicamente) — nessun merge incrementale, overwrite
 * intero ad ogni poll.
 */
export function extractSendStatusHistory(data: unknown): SendStatusHistoryEntry[] {
  const history = (data as { notificationStatusHistory?: unknown })?.notificationStatusHistory;
  if (!Array.isArray(history)) return [];
  return history.map((h: any) => ({ status: h?.status, activeFrom: h?.activeFrom }));
}

/**
 * Estrae il domicilio digitale (o il fallback cartaceo) dall'evento più
 * recente della timeline: un SEND_ANALOG_DOMICILE successivo a un
 * SEND_DIGITAL_DOMICILE rappresenta un fallback cartaceo e vince, essendo
 * l'ultimo tentativo di recapito effettivamente scelto da PN.
 */
export function extractSendDigitalDomicile(data: unknown): SendDigitalDomicile | null {
  const timeline = (data as { timeline?: unknown })?.timeline;
  if (!Array.isArray(timeline)) return null;

  let result: SendDigitalDomicile | null = null;
  for (const el of timeline as any[]) {
    if (el?.category === 'SEND_DIGITAL_DOMICILE' && el?.details?.digitalAddress) {
      result = {
        type: el.details.digitalAddress.type ?? null,
        address: el.details.digitalAddress.address ?? null,
        source: el.details.digitalAddressSource ?? null,
      };
    } else if (el?.category === 'SEND_ANALOG_DOMICILE') {
      result = { type: 'CARTACEO', address: null, source: 'ANALOG' };
    }
  }
  return result;
}

export interface SendAnalogCostEvent {
  productType: string | null;
  analogCostCents: number;
  envelopeWeight: number | null;
  numberOfPages: number | null;
}

export interface SendAnalogCostInfo {
  analogCostCents: number;
  events: SendAnalogCostEvent[];
}

const ANALOG_CATEGORIES_WITH_COST = ['SEND_ANALOG_DOMICILE', 'SEND_SIMPLE_REGISTERED_LETTER'];

/**
 * Somma analogCost (già in eurocent, campo reale PN) su TUTTI gli eventi
 * analogici della timeline di un IUN — un IUN può avere più eventi (es.
 * primo tentativo fallito + rispedizione), ognuno con un costo reale
 * proprio. Vedi docs/superpowers/specs/2026-07-21-costo-notifiche-design.md.
 */
export function extractSendAnalogCost(data: unknown): SendAnalogCostInfo {
  const timeline = (data as { timeline?: unknown })?.timeline;
  if (!Array.isArray(timeline)) return { analogCostCents: 0, events: [] };

  const events: SendAnalogCostEvent[] = [];
  for (const el of timeline as any[]) {
    if (ANALOG_CATEGORIES_WITH_COST.includes(el?.category) && typeof el?.details?.analogCost === 'number') {
      events.push({
        productType: el.details.productType ?? null,
        analogCostCents: el.details.analogCost,
        envelopeWeight: el.details.envelopeWeight ?? null,
        numberOfPages: el.details.numberOfPages ?? null,
      });
    }
  }

  return { analogCostCents: events.reduce((sum, e) => sum + e.analogCostCents, 0), events };
}
