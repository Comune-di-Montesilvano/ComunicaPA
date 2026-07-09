import type { DownloadReportRowDto } from './dto/campaign-stats.dto';
import { escapeCsvField } from './csv.util';

export function buildDownloadReportCsv(rows: DownloadReportRowDto[]): string {
  const header = ['Codice Fiscale', 'Nominativo', 'Email', 'PEC', 'Stato Invio', 'Download Effettuati', 'Data Ultimo Download']
    .map(escapeCsvField)
    .join(';');

  const lines = rows.map((r) =>
    [
      r.codiceFiscale,
      r.fullName ?? '',
      r.email ?? '',
      r.pec ?? '',
      r.status,
      String(r.downloadCount),
      r.lastDownloadedAt ? new Date(r.lastDownloadedAt).toLocaleString('it-IT') : '',
    ]
      .map(escapeCsvField)
      .join(';'),
  );

  return [header, ...lines].join('\n');
}
