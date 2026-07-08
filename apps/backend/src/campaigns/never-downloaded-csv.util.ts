import type { NeverDownloadedRowDto } from './dto/global-stats.dto';

function escapeCsvField(value: string): string {
  // Previene CSV/formula injection: Excel interpreta come formula un campo
  // il cui contenuto (dopo aver rimosso le virgolette di CSV) inizia con
  // = + - @. Anteponendo un apice si forza Excel a trattarlo come testo.
  const sanitized = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${sanitized.replace(/"/g, '""')}"`;
}

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
