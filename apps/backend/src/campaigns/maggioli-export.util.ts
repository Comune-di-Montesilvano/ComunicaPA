import type { PostalReportRowDto, SendDeliveryKind, SendReportRowDto } from './dto/campaign-stats.dto.js';
import type { SendTimelineEvent } from '../channels/send/send-status-history.util.js';
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
  /** Campo "Numero raccomandata" (12-23): numero, o protocollo n/anno se non c'è raccomandata. */
  raccomandata: string | null;
  /** Campo note "Raccomandata atto" (52-63): canale (RACC, PEC, SEND PEC, ...). */
  canale: string;
}

export interface MaggioliMancata {
  ocr: string;
  /** Campi "Numero raccomandata atto" e "A/R" (3-26): numero, o protocollo n/anno se non c'è raccomandata. */
  raccomandata: string | null;
  /** Campo note "Numero inkjet" (65-80): canale (RACC, PEC, SEND PEC, ...). */
  canale: string;
  /** Campo note "Lotto" (81-95): protocollo n/anno, anche quando c'è la raccomandata. */
  protocollo: string | null;
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
  /** Destinatari della campagna (con o senza esito) senza OCR utilizzabile. */
  ocrMancanti: number;
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

/**
 * Canale SEND della consegna:
 * - letta (VIEWED) prima del perfezionamento per decorrenza: RADD se aperta
 *   allo sportello, IO se SEND ha mandato il messaggio di cortesia su App IO
 *   (PN non dice da dove è stata aperta), altrimenti WEB;
 * - altrimenti dalla timeline: raccomandata del recapitista (anche
 *   irreperibile/restituita) → RACC, domicilio digitale → PEC.
 */
export function sendDeliveryKind(
  history: Array<{ status: string; activeFrom: string }> | null | undefined,
  timeline: SendTimelineEvent[] | null | undefined,
  digitalDomicileType: string | null | undefined,
): SendDeliveryKind | null {
  const ev = timeline ?? [];
  const legal = sendLegalDateOf(history);
  const viewed = (history ?? []).find((h) => h.status === 'VIEWED')?.activeFrom;
  if (legal && viewed === legal) {
    if (ev.some((e) => e.category === 'NOTIFICATION_VIEWED' && e.raddType)) return 'RADD';
    if (ev.some((e) => e.category === 'SEND_COURTESY_MESSAGE' && e.channel === 'APPIO')) return 'IO';
    return 'WEB';
  }
  const analog = ['SEND_ANALOG_DOMICILE', 'SEND_SIMPLE_REGISTERED_LETTER', 'SEND_ANALOG_FEEDBACK', 'ANALOG_SUCCESS_WORKFLOW', 'ANALOG_FAILURE_WORKFLOW', 'COMPLETELY_UNREACHABLE'];
  if (ev.some((e) => analog.includes(e.category)) || digitalDomicileType === 'CARTACEO') return 'RACC';
  if (ev.some((e) => e.category === 'SEND_DIGITAL_DOMICILE' || e.category === 'DIGITAL_SUCCESS_WORKFLOW') || digitalDomicileType) return 'PEC';
  if ((history ?? []).some((h) => h.status === 'UNREACHABLE' || h.status === 'RETURNED_TO_SENDER')) return 'RACC';
  return null;
}

/** Ultimo codice raccomandata del recapitista SEND nella timeline. */
export function sendRegisteredLetterOf(timeline: SendTimelineEvent[] | null | undefined): string | null {
  return [...(timeline ?? [])].reverse().find((e) => e.registeredLetterCode)?.registeredLetterCode ?? null;
}

/** Sigla del canale nei campi note (max 12: entra anche nella "raccomandata atto" delle notifiche). */
const SEND_KIND_LABEL: Record<SendDeliveryKind, string> = { PEC: 'SEND PEC', RACC: 'SEND RACC', IO: 'SEND APPIO', WEB: 'SEND WEB', RADD: 'SEND RADD' };

/**
 * Con il numero di raccomandata: il numero nei campi raccomandata e note
 * vuote (per SEND la sigla del canale c'è comunque). Senza (dirottati PEC,
 * SEND digitale): protocollo n/anno nei campi raccomandata, canale nelle
 * note e, nelle mancate, protocollo anche nel lotto.
 */
function maggioliFields(
  numero: string | null,
  canale: string,
  protocol: string | null,
  canaleSempre: boolean,
): { raccomandata: string | null; canale: string; protocollo: string | null } {
  if (numero) return { raccomandata: numero, canale: canaleSempre ? canale : '', protocollo: null };
  return { raccomandata: fitProtocol(protocol, 12), canale, protocollo: fitProtocol(protocol, 15) };
}

/** Protocollo n/anno in `length` caratteri: se non ci sta, anno a 2 cifre (12345678/2026 → 12345678/26). */
export function fitProtocol(protocol: string | null, length: number): string | null {
  if (!protocol || protocol.length <= length) return protocol;
  return protocol.replace(/\/(?:19|20)(\d{2})$/, '/$1');
}

/** Protocollo "numero/anno" del tentativo protocollato più recente. */
export function protocolOf(attempts: Array<{ attemptNumber: number; protocolNumber?: number | null; protocolYear?: number | null } | null | undefined>): string | null {
  const best = attempts
    .filter((a): a is { attemptNumber: number; protocolNumber: number; protocolYear?: number | null } => !!a && a.protocolNumber !== null && a.protocolNumber !== undefined)
    .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
  if (!best) return null;
  return best.protocolYear ? `${best.protocolNumber}/${best.protocolYear}` : String(best.protocolNumber);
}

/** gg/mm/aaaa nel fuso italiano. */
export function maggioliDate(iso: string): string {
  return new Date(iso).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function field(value: string | null | undefined, length: number): string {
  return (value ?? '').replace(/[\r\n]/g, ' ').slice(0, length).padEnd(length, ' ');
}

export function maggioliFromPostal(rows: PostalReportRowDto[]): MaggioliExport {
  const out: MaggioliExport = { notifiche: [], mancate: [], senzaOcr: 0, ocrMancanti: 0, nonEsportabili: 0 };
  for (const r of rows) {
    if (!maggioliOcr(r.externalId)) out.ocrMancanti++;
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
    // Dirottato su PEC: nessuna raccomandata, sigla PEC.
    const f = reason === 'Via PEC'
      ? maggioliFields(null, 'PEC', r.protocol, false)
      : maggioliFields(r.postalAcceptanceId ?? null, 'RACC', r.protocol, false);
    if (delivered) {
      out.notifiche.push({ ocr, dataNotifica: r.legalOutcomeAt!, raccomandata: f.raccomandata, canale: f.canale });
    } else {
      out.mancate.push({
        ocr,
        ...f,
        tipo: POSTAL_MANCATA_TIPO[r.postalDeliveryStatus ?? ''] ?? ' N',
        dataEmissione: r.sentAt ?? r.postalStatusHistory[0]?.rilevatoIl ?? null,
        dataMancata: dataMancata!,
      });
    }
  }
  return out;
}

export function maggioliFromSend(rows: SendReportRowDto[]): MaggioliExport {
  const out: MaggioliExport = { notifiche: [], mancate: [], senzaOcr: 0, ocrMancanti: 0, nonEsportabili: 0 };
  for (const r of rows) {
    if (!maggioliOcr(r.externalId)) out.ocrMancanti++;
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
    const kind = r.sendDeliveryKind ?? (legal ? null : 'RACC');
    const f = maggioliFields(kind === 'RACC' ? r.sendRegisteredLetterCode : null, kind ? SEND_KIND_LABEL[kind] : 'SEND', r.protocol, true);
    if (legal) {
      out.notifiche.push({ ocr, dataNotifica: legal, raccomandata: f.raccomandata, canale: f.canale });
    } else {
      out.mancate.push({
        ocr,
        ...f,
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
    field(n.raccomandata, 12),        // 12-23  numero raccomandata, o protocollo
    'N',                              // 24     compiuta giacenza: notifica alla data indicata
    'A',                              // 25     indicatore tracciato
    n.ocr,                            // 26-41  riferimento verbale
    field('', 8),                     // 42-49  numero inkjet
    field('', 2),                     // 50-51  filler
    field(n.canale, 12),              // 52-63  raccomandata atto (note): canale
    'A',                              // 64     filler
  ].join('')).map((l) => `${l}\n`).join('');
}

/** Tracciato Importazione Mancate Notifiche: 150 caratteri per record. */
export function buildMaggioliMancateTxt(records: MaggioliMancata[]): string {
  return records.map((m) => [
    '01',                                                 // 1-2     flag nuovo tracciato
    field(m.raccomandata, 12),                            // 3-14    raccomandata atto: numero o protocollo
    field(m.raccomandata, 12),                            // 15-26   raccomandata A/R (si può ripetere)
    m.ocr,                                                // 27-42   riferimento verbale
    m.tipo,                                               // 43-44   tipo mancata notifica
    field(m.dataEmissione ? maggioliDate(m.dataEmissione) : maggioliDate(m.dataMancata), 10), // 45-54 data emissione atto
    maggioliDate(m.dataMancata),                          // 55-64   data mancata notifica
    field(m.canale, 16),                                  // 65-80   numero inkjet (note): canale
    field(m.protocollo, 15),                              // 81-95   lotto (note): protocollo
    field('', 55),                                        // 96-150  filler
  ].join('')).map((l) => `${l}\n`).join('');
}
