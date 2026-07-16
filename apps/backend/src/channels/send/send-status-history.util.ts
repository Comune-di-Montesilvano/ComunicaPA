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
