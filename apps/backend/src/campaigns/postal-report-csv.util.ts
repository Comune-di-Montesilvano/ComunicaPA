import { escapeCsvField } from './csv.util';
import type { PostalReportDto, PostalReportRowDto } from './dto/campaign-stats.dto';
import { postalStatusLabel, POSTAL_STATUS_HISTORY_COLUMNS } from './postal-status-labels.util';

function formatDate(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString('it-IT', { timeZone: 'Europe/Rome' }) : '';
}

function appIoOutcomeLabel(outcome: PostalReportRowDto['appIoOutcome']): string {
  if (!outcome) return '';
  return outcome.success ? 'Consegnato' : `Fallito: ${outcome.error ?? ''}`;
}

export function buildPostalReportAttualeCsv(report: PostalReportDto): string {
  const headers = ['Codice Fiscale', 'Nominativo', 'IDPRO', 'Stato', 'Data Stato', 'Codice Errore', 'Descrizione Errore'];
  if (report.hasAppIoCoDelivery) headers.push('Esito App IO');

  const lines = report.rows.map((r) => {
    // postalStatusHistory è append-only in ordine cronologico: l'ultimo
    // elemento è lo stato corrente.
    const latestEntry = r.postalStatusHistory[r.postalStatusHistory.length - 1];
    const fields = [
      r.codiceFiscale,
      r.fullName ?? '',
      r.postalTrackingId ?? '',
      postalStatusLabel(r.postalStatus),
      formatDate(latestEntry?.rilevatoIl),
      r.codiceErrore ?? '',
      r.descrizioneErrore ?? '',
    ];
    if (report.hasAppIoCoDelivery) fields.push(appIoOutcomeLabel(r.appIoOutcome));
    return fields.map(escapeCsvField).join(';');
  });

  return [headers.map(escapeCsvField).join(';'), ...lines].join('\n');
}

export function buildPostalReportStoricoCsv(report: PostalReportDto): string {
  const headers = [
    'Codice Fiscale', 'Nominativo', 'IDPRO', 'Codice Errore', 'Descrizione Errore',
    ...POSTAL_STATUS_HISTORY_COLUMNS.map((c) => c.header),
  ];
  if (report.hasAppIoCoDelivery) headers.push('Esito App IO');

  const lines = report.rows.map((r) => {
    // Prima occorrenza per stato (uno stato transitorio come "Rimandato" può
    // ripetersi più volte sui retry GBC): si registra solo la prima volta.
    const firstOccurrenceByStatus = new Map<string, string>();
    for (const h of r.postalStatusHistory) {
      if (!firstOccurrenceByStatus.has(h.stato)) firstOccurrenceByStatus.set(h.stato, h.rilevatoIl);
    }
    const fields = [
      r.codiceFiscale,
      r.fullName ?? '',
      r.postalTrackingId ?? '',
      r.codiceErrore ?? '',
      r.descrizioneErrore ?? '',
      ...POSTAL_STATUS_HISTORY_COLUMNS.map((c) => formatDate(firstOccurrenceByStatus.get(c.status))),
    ];
    if (report.hasAppIoCoDelivery) fields.push(appIoOutcomeLabel(r.appIoOutcome));
    return fields.map(escapeCsvField).join(';');
  });

  return [headers.map(escapeCsvField).join(';'), ...lines].join('\n');
}
