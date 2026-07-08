import type { NeverDownloadedRowDto } from './dto/global-stats.dto';
import { escapeCsvField } from './csv.util';

export function buildNeverDownloadedCsv(rows: NeverDownloadedRowDto[]): string {
  const header = ['Codice Fiscale', 'Nominativo', 'Campagna', 'Canale', 'Stato', 'Data invio']
    .map(escapeCsvField)
    .join(';');

  const lines = rows.map((r) =>
    [
      r.codiceFiscale,
      r.fullName ?? '',
      r.campaignName,
      r.channelType,
      r.status,
      new Date(r.createdAt).toLocaleString('it-IT'),
    ]
      .map(escapeCsvField)
      .join(';'),
  );

  return [header, ...lines].join('\n');
}
