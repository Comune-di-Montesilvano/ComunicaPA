import { buildNeverDownloadedCsv } from './never-downloaded-csv.util';

describe('buildNeverDownloadedCsv', () => {
  it('produce header e righe separate da ; con escaping delle virgolette', () => {
    const csv = buildNeverDownloadedCsv([
      {
        codiceFiscale: 'AAA1',
        fullName: 'Mario "Rossi"',
        campaignName: 'Tari 2026',
        channelType: 'EMAIL',
        status: 'sent',
        createdAt: '2026-06-01T10:00:00.000Z',
      },
    ]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"Codice Fiscale";"Nominativo";"Campagna";"Canale";"Stato";"Data invio"');
    expect(lines[1]).toContain('"AAA1"');
    expect(lines[1]).toContain('"Mario ""Rossi"""');
  });

  it('sostituisce fullName null con stringa vuota', () => {
    const csv = buildNeverDownloadedCsv([
      { codiceFiscale: 'BBB2', fullName: null, campaignName: 'Tari', channelType: 'PEC', status: 'sent', createdAt: '2026-06-01T10:00:00.000Z' },
    ]);
    expect(csv.split('\n')[1]).toContain('"";"Tari"');
  });

  it('ritorna solo l\'header quando non ci sono righe', () => {
    const csv = buildNeverDownloadedCsv([]);
    expect(csv.split('\n')).toHaveLength(1);
  });
});
