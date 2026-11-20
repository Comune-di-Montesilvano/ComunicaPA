import type { PostalReportRowDto, SendReportRowDto } from './dto/campaign-stats.dto.js';
import { LEGAL_NOT_DELIVERED_STATUSES } from './postal-legal-outcome.util.js';
import { sendLegalDateOf, sendEntityLegalDateOf } from './send-legal-date.util.js';

/**
 * Esportazione esiti per Sicr@Web (Maggioli), tracciati "Service Maggioli":
 * - Importazione Notifiche (16/08/2023): record a lunghezza fissa di 64 caratteri;
 * - Importazione Mancate Notifiche (19/09/2023): record di 150 caratteri.
 * Chiave = "Riferimento verbale": primi 16 caratteri del codice OCR (quinto
 * campo) senza i 2 caratteri di controllo, cioè l'external ID della campagna.
 */

export interface MaggioliNotifica {
  ocr: string;
  /** Data legale di notifica (ISO). */
  dataNotifica: string;
  raccomandata: string | null;
}

export interface MaggioliMancata {
  ocr: string;
  raccomandata: string | null;
  /** Codice tipo mancata notifica, 2 caratteri (cifra preceduta da spazio). */
  tipo: string;
  dataEmissione: string | null;
  dataMancata: string;
}

export interface MaggioliExport {
  notifiche: MaggioliNotifica[];
  mancate: MaggioliMancata[];
  /** Destinatari con esito ma senza OCR utilizzabile (external ID assente o < 16 caratteri). */
  senzaOcr: number;
  /** In corso, errori d'invio, annullate: nessun record. */
  nonEsportabili: number;
}

/** Codici "tipo mancata notifica" dalle causali GlobalCom (StatoConsegna). */
const POSTAL_MANCATA_TIPO: Record<string, string> = {
  'Destinatario sconosciuto': ' 1',
  'Destinatario trasferito': ' 3',
  'Destinatario irreperibile': ' 4',
  'Destinatario deceduto': ' 5',
  'Indirizzo insufficiente': ' 6',
  'Indirizzo errato o inesatto': ' 7',
  'Indirizzo sconosciuto': ' 8',
};

/** Riferimento verbale: primi 16 caratteri dell'OCR (alfanumerico), null se troppo corto. */
export function maggioliOcr(externalId: string | null | undefined): string | null {
  const v = (externalId ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  return v.length >= 16 ? v.slice(0, 16) : null;
}

/** gg/mm/aaaa nel fuso italiano. */
export function maggioliDate(iso: string): string {
  return new Date(iso).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function field(value: string | null | undefined, length: number): string {
  return (value ?? '').replace(/[\r\n]/g, ' ').slice(0, length).padEnd(length, ' ');
}

export function maggioliFromPostal(rows: PostalReportRowDto[]): MaggioliExport {
  const out: MaggioliExport = { notifiche: [], mancate: [], senzaOcr: 0, nonEsportabili: 0 };
  for (const r of rows) {
    const reason = r.legalOutcomeReason ?? '';
    const delivered = r.legalOutcome === 'delivered' && !!r.legalOutcomeAt;
    const returned = r.legalOutcome === 'not_delivered' && LEGAL_NOT_DELIVERED_STATUSES.includes(r.postalDeliveryStatus ?? '');
    const dataMancata = r.postalDeliveryDate ?? r.postalStatusHistory.at(-1)?.rilevatoIl ?? null;
    if (!delivered && !(returned && dataMancata)) {
      out.nonEsportabili++;
      continue;
    }
    const ocr = maggioliOcr(r.externalId);
    if (!ocr) {
      out.senzaOcr++;
      continue;
    }
    // Dirottato su PEC: nessuna raccomandata.
    const raccomandata = reason === 'Via PEC' ? null : (r.postalAcceptanceId ?? null);
    if (delivered) {
      out.notifiche.push({ ocr, dataNotifica: r.legalOutcomeAt!, raccomandata });
    } else {
      out.mancate.push({
        ocr,
        raccomandata,
        tipo: POSTAL_MANCATA_TIPO[r.postalDeliveryStatus ?? ''] ?? ' N',
        dataEmissione: r.sentAt ?? r.postalStatusHistory[0]?.rilevatoIl ?? null,
        dataMancata: dataMancata!,
      });
    }
  }
  return out;
}

export function maggioliFromSend(rows: SendReportRowDto[]): MaggioliExport {
  const out: MaggioliExport = { notifiche: [], mancate: [], senzaOcr: 0, nonEsportabili: 0 };
  for (const r of rows) {
    const legal = sendLegalDateOf(r.sendStatusHistory);
    const failure = legal ? undefined : r.sendStatusHistory.find((h) => h.status === 'UNREACHABLE' || h.status === 'RETURNED_TO_SENDER');
    if (!legal && !failure) {
      out.nonEsportabili++;
      continue;
    }
    const ocr = maggioliOcr(r.externalId);
    if (!ocr) {
      out.senzaOcr++;
      continue;
    }
    if (legal) {
      out.notifiche.push({ ocr, dataNotifica: legal, raccomandata: null });
    } else {
      out.mancate.push({
        ocr,
        raccomandata: null,
        tipo: failure!.status === 'UNREACHABLE' ? ' 4' : ' N',
        dataEmissione: sendEntityLegalDateOf(r.sendStatusHistory),
        dataMancata: failure!.activeFrom,
      });
    }
  }
  return out;
}

/** Tracciato Importazione Notifiche: 64 caratteri per record, fine riga LF come il file d'esempio. */
export function buildMaggioliNotificheTxt(records: MaggioliNotifica[]): string {
  return records.map((n) => [
    'B',                              // 1      flag nuovo tracciato
    maggioliDate(n.dataNotifica),     // 2-11   data notifica gg/mm/aaaa
    field(n.raccomandata, 12),        // 12-23  numero raccomandata
    'N',                              // 24     compiuta giacenza: notifica alla data indicata
    'A',                              // 25     indicatore tracciato
    n.ocr,                            // 26-41  riferimento verbale
    field('', 8),                     // 42-49  numero inkjet
    field('', 2),                     // 50-51  filler
    field(n.raccomandata, 12),        // 52-63  raccomandata atto (note)
    'A',                              // 64     filler
  ].join('')).map((l) => `${l}\n`).join('');
}

/** Tracciato Importazione Mancate Notifiche: 150 caratteri per record. */
export function buildMaggioliMancateTxt(records: MaggioliMancata[]): string {
  return records.map((m) => [
    '01',                                                 // 1-2     flag nuovo tracciato
    field(m.raccomandata, 12),                            // 3-14    raccomandata atto
    field(m.raccomandata, 12),                            // 15-26   raccomandata A/R (si può ripetere)
    m.ocr,                                                // 27-42   riferimento verbale
    m.tipo,                                               // 43-44   tipo mancata notifica
    field(m.dataEmissione ? maggioliDate(m.dataEmissione) : maggioliDate(m.dataMancata), 10), // 45-54 data emissione atto
    maggioliDate(m.dataMancata),                          // 55-64   data mancata notifica
    field('', 16),                                        // 65-80   numero inkjet
    field('', 15),                                        // 81-95   lotto
    field('', 55),                                        // 96-150  filler
  ].join('')).map((l) => `${l}\n`).join('');
}
