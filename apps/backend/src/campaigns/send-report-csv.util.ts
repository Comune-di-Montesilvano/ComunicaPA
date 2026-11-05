import { escapeCsvField } from './csv.util.js';
import type { SendReportDto, SendReportRowDto } from './dto/campaign-stats.dto.js';
import { sendStatusLabel, digitalDomicileTypeLabel, SEND_STATUS_HISTORY_COLUMNS } from './send-status-labels.util.js';
import { sendEntityLegalDateOf, sendLegalDateOf } from './send-legal-date.util.js';

// Data legale per l'ente (art. 26 c. 9 lett. a) e perfezionamento per il
// destinatario (lett. b): stesse colonne in entrambi i report.
const LEGAL_HEADERS = ["Notificata per l'ente", 'Notificata per il destinatario'];
function legalFields(history: SendReportRowDto['sendStatusHistory']): string[] {
  return [formatDate(sendEntityLegalDateOf(history) ?? undefined), formatDate(sendLegalDateOf(history) ?? undefined)];
}

function formatDate(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString('it-IT', { timeZone: 'Europe/Rome' }) : '';
}

function appIoOutcomeLabel(outcome: SendReportRowDto['appIoOutcome']): string {
  if (!outcome) return '';
  return outcome.success ? 'Consegnato' : `Fallito: ${outcome.error ?? ''}`;
}

export function buildSendReportAttualeCsv(report: SendReportDto): string {
  const headers = ['Codice Fiscale', 'Nominativo', 'IUN', 'Tipo Domicilio Digitale', 'Indirizzo Domicilio', 'Stato', 'Data Stato', ...LEGAL_HEADERS];
  if (report.hasAppIoCoDelivery) headers.push('Esito App IO');
  if (report.hasExternalId) headers.push('External ID');

  const lines = report.rows.map((r) => {
    // sendStatusHistory è ordinato cronologicamente (copia diretta di
    // notificationStatusHistory da PN): l'ultimo elemento è lo stato corrente.
    const latestEntry = r.sendStatusHistory[r.sendStatusHistory.length - 1];
    const fields = [
      r.codiceFiscale,
      r.fullName ?? '',
      r.iun ?? '',
      digitalDomicileTypeLabel(r.digitalDomicileType),
      r.digitalDomicileAddress ?? '',
      sendStatusLabel(r.sendStatus),
      formatDate(latestEntry?.activeFrom),
      ...legalFields(r.sendStatusHistory),
    ];
    if (report.hasAppIoCoDelivery) fields.push(appIoOutcomeLabel(r.appIoOutcome));
    if (report.hasExternalId) fields.push(r.externalId ?? '');
    return fields.map(escapeCsvField).join(';');
  });

  return [headers.map(escapeCsvField).join(';'), ...lines].join('\n');
}

export function buildSendReportStoricoCsv(report: SendReportDto): string {
  const headers = [
    'Codice Fiscale', 'Nominativo', 'IUN', 'Tipo Domicilio Digitale', 'Indirizzo Domicilio',
    ...SEND_STATUS_HISTORY_COLUMNS.map((c) => c.header),
    ...LEGAL_HEADERS,
  ];
  if (report.hasAppIoCoDelivery) headers.push('Esito App IO');
  if (report.hasExternalId) headers.push('External ID');

  const lines = report.rows.map((r) => {
    const historyByStatus = new Map(r.sendStatusHistory.map((h) => [h.status, h.activeFrom]));
    const fields = [
      r.codiceFiscale,
      r.fullName ?? '',
      r.iun ?? '',
      digitalDomicileTypeLabel(r.digitalDomicileType),
      r.digitalDomicileAddress ?? '',
      ...SEND_STATUS_HISTORY_COLUMNS.map((c) => formatDate(historyByStatus.get(c.status))),
      ...legalFields(r.sendStatusHistory),
    ];
    if (report.hasAppIoCoDelivery) fields.push(appIoOutcomeLabel(r.appIoOutcome));
    if (report.hasExternalId) fields.push(r.externalId ?? '');
    return fields.map(escapeCsvField).join(';');
  });

  return [headers.map(escapeCsvField).join(';'), ...lines].join('\n');
}
