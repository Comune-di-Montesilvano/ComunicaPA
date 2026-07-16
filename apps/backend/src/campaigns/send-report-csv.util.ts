import { escapeCsvField } from './csv.util';
import type { SendReportDto, SendReportRowDto } from './dto/campaign-stats.dto';
import { sendStatusLabel, digitalDomicileTypeLabel, SEND_STATUS_HISTORY_COLUMNS } from './send-status-labels.util';

function formatDate(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString('it-IT', { timeZone: 'Europe/Rome' }) : '';
}

function appIoOutcomeLabel(outcome: SendReportRowDto['appIoOutcome']): string {
  if (!outcome) return '';
  return outcome.success ? 'Consegnato' : `Fallito: ${outcome.error ?? ''}`;
}

export function buildSendReportAttualeCsv(report: SendReportDto): string {
  const headers = ['Codice Fiscale', 'Nominativo', 'IUN', 'Tipo Domicilio Digitale', 'Indirizzo Domicilio', 'Stato', 'Data Stato'];
  if (report.hasAppIoCoDelivery) headers.push('Esito App IO');

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
    ];
    if (report.hasAppIoCoDelivery) fields.push(appIoOutcomeLabel(r.appIoOutcome));
    return fields.map(escapeCsvField).join(';');
  });

  return [headers.map(escapeCsvField).join(';'), ...lines].join('\n');
}

export function buildSendReportStoricoCsv(report: SendReportDto): string {
  const headers = [
    'Codice Fiscale', 'Nominativo', 'IUN', 'Tipo Domicilio Digitale', 'Indirizzo Domicilio',
    ...SEND_STATUS_HISTORY_COLUMNS.map((c) => c.header),
  ];
  if (report.hasAppIoCoDelivery) headers.push('Esito App IO');

  const lines = report.rows.map((r) => {
    const historyByStatus = new Map(r.sendStatusHistory.map((h) => [h.status, h.activeFrom]));
    const fields = [
      r.codiceFiscale,
      r.fullName ?? '',
      r.iun ?? '',
      digitalDomicileTypeLabel(r.digitalDomicileType),
      r.digitalDomicileAddress ?? '',
      ...SEND_STATUS_HISTORY_COLUMNS.map((c) => formatDate(historyByStatus.get(c.status))),
    ];
    if (report.hasAppIoCoDelivery) fields.push(appIoOutcomeLabel(r.appIoOutcome));
    return fields.map(escapeCsvField).join(';');
  });

  return [headers.map(escapeCsvField).join(';'), ...lines].join('\n');
}
