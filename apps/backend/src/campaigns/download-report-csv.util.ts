import type { DownloadReportDto } from './dto/campaign-stats.dto';
import { escapeCsvField } from './csv.util';

export function buildDownloadReportCsv(report: DownloadReportDto): string {
  const headers = ['Codice Fiscale', 'Nominativo', 'Email', 'PEC', 'Stato Invio', 'Download Effettuati', 'Data Ultimo Download'];
  if (report.hasExternalId) headers.push('External ID');

  const lines = report.rows.map((r) => {
    const fields = [
      r.codiceFiscale,
      r.fullName ?? '',
      r.email ?? '',
      r.pec ?? '',
      r.status,
      String(r.downloadCount),
      r.lastDownloadedAt ? new Date(r.lastDownloadedAt).toLocaleString('it-IT', { timeZone: 'Europe/Rome' }) : '',
    ];
    if (report.hasExternalId) fields.push(r.externalId ?? '');
    return fields.map(escapeCsvField).join(';');
  });

  return [headers.map(escapeCsvField).join(';'), ...lines].join('\n');
}
