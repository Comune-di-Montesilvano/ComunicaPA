import { buildDownloadReportCsv } from './download-report-csv.util';

describe('buildDownloadReportCsv', () => {
  it('produce header e righe separate da ; con i campi attesi', () => {
    const csv = buildDownloadReportCsv({
      hasExternalId: false,
      rows: [
        {
          codiceFiscale: 'AAA1',
          fullName: 'Mario Rossi',
          email: 'mario@example.com',
          pec: null,
          status: 'sent',
          downloadCount: 2,
          lastDownloadedAt: '2026-07-01T10:00:00.000Z',
          externalId: null,
        },
      ],
    });
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"Codice Fiscale";"Nominativo";"Email";"PEC";"Stato Invio";"Download Effettuati";"Data Ultimo Download"');
    expect(lines[1]).toContain('"AAA1"');
    expect(lines[1]).toContain('"mario@example.com"');
    expect(lines[1]).toContain('"2"');
  });

  it('sostituisce campi null con stringa vuota', () => {
    const csv = buildDownloadReportCsv({
      hasExternalId: false,
      rows: [
        { codiceFiscale: 'BBB2', fullName: null, email: null, pec: null, status: 'pending', downloadCount: 0, lastDownloadedAt: null, externalId: null },
      ],
    });
    const line = csv.split('\n')[1];
    expect(line).toBe('"BBB2";"";"";"";"pending";"0";""');
  });

  it('ritorna solo l\'header quando non ci sono righe', () => {
    expect(buildDownloadReportCsv({ hasExternalId: false, rows: [] }).split('\n')).toHaveLength(1);
  });

  it('aggiunge la colonna External ID solo se almeno una riga la valorizza', () => {
    const csv = buildDownloadReportCsv({
      hasExternalId: true,
      rows: [
        { codiceFiscale: 'AAA1', fullName: 'Mario Rossi', email: null, pec: null, status: 'sent', downloadCount: 0, lastDownloadedAt: null, externalId: '5890000000049995' },
      ],
    });
    const lines = csv.split('\n');
    expect(lines[0]).toContain('"External ID"');
    expect(lines[1]).toContain('"5890000000049995"');
  });

  it('non aggiunge la colonna External ID se nessuna riga la valorizza', () => {
    const csv = buildDownloadReportCsv({
      hasExternalId: false,
      rows: [
        { codiceFiscale: 'AAA1', fullName: 'Mario Rossi', email: null, pec: null, status: 'sent', downloadCount: 0, lastDownloadedAt: null, externalId: null },
      ],
    });
    expect(csv.split('\n')[0]).not.toContain('External ID');
  });
});
