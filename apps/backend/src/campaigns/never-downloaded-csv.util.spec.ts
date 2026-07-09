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
    // Blocca la formattazione locale it-IT (dipende dai dati ICU compilati nel
    // runtime Node): se l'immagine Docker cambia e perde il supporto ICU
    // completo, questa asserzione deve fallire prima che l'export CSV arrivi
    // in produzione con un formato data inatteso. timeZone fissato a
    // Europe/Rome nella util stessa (non dipende dal TZ del processo): 10:00
    // UTC = 12:00 CEST in giugno, indipendentemente da dove gira il test.
    expect(lines[1]).toContain('"01/06/2026, 12:00:00"');
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

  it('previene la CSV/formula injection anteponendo un apice ai campi che iniziano con = + - @', () => {
    const csv = buildNeverDownloadedCsv([
      {
        codiceFiscale: 'CCC3',
        fullName: '=HYPERLINK("http://evil.com","click")',
        campaignName: '+Tari 2026',
        channelType: 'EMAIL',
        status: 'sent',
        createdAt: '2026-06-01T10:00:00.000Z',
      },
    ]);
    const dataLine = csv.split('\n')[1];
    expect(dataLine).toContain('"\'=HYPERLINK(""http://evil.com"",""click"")"');
    expect(dataLine).toContain('"\'+Tari 2026"');
  });

  it('non altera un campo normale che non inizia con = + - @', () => {
    const csv = buildNeverDownloadedCsv([
      { codiceFiscale: 'DDD4', fullName: 'Mario Rossi', campaignName: 'Tari', channelType: 'PEC', status: 'sent', createdAt: '2026-06-01T10:00:00.000Z' },
    ]);
    expect(csv.split('\n')[1]).toContain('"Mario Rossi"');
  });
});
