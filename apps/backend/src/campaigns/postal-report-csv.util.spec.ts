import { buildPostalReportAttualeCsv, buildPostalReportStoricoCsv } from './postal-report-csv.util';
import type { PostalReportDto } from './dto/campaign-stats.dto';

const baseReport: PostalReportDto = {
  hasAppIoCoDelivery: false,
  rows: [{
    codiceFiscale: 'RSSMRA80A01H501U',
    fullName: 'Mario Rossi',
    postalTrackingId: 'IDPRO1',
    postalStatus: 'Consegnato',
    postalStatusHistory: [
      { stato: 'Accettato', rilevatoIl: '2026-01-10T10:00:00Z' },
      { stato: 'Inviato', rilevatoIl: '2026-01-11T10:00:00Z' },
      { stato: 'Rimandato', rilevatoIl: '2026-01-12T10:00:00Z' },
      { stato: 'Rimandato', rilevatoIl: '2026-01-13T10:00:00Z' },
      { stato: 'Consegnato', rilevatoIl: '2026-01-14T09:00:00Z' },
    ],
    codiceErrore: null,
    descrizioneErrore: null,
    appIoOutcome: null,
  }],
};

describe('buildPostalReportAttualeCsv', () => {
  it('include intestazioni e riga con stato/data correnti (ultimo elemento storico)', () => {
    const csv = buildPostalReportAttualeCsv(baseReport);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"Codice Fiscale";"Nominativo";"IDPRO";"Stato";"Data Stato";"Codice Errore";"Descrizione Errore"');
    expect(lines[1]).toContain('"Consegnato"');
    expect(lines[1]).not.toContain('Esito App IO');
  });

  it('aggiunge la colonna Esito App IO solo se hasAppIoCoDelivery', () => {
    const report: PostalReportDto = {
      hasAppIoCoDelivery: true,
      rows: [{ ...baseReport.rows[0], appIoOutcome: { success: true, error: null } }],
    };
    const csv = buildPostalReportAttualeCsv(report);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('"Esito App IO"');
    expect(lines[1]).toContain('"Consegnato"');
  });
});

describe('buildPostalReportStoricoCsv', () => {
  it('include una colonna data per ciascuno dei 14 stati, vuota se mai raggiunto', () => {
    const csv = buildPostalReportStoricoCsv(baseReport);
    const lines = csv.split('\n');
    expect(lines[0].split(';')).toHaveLength(5 + 14);
    const headers = lines[0].split(';');
    const sospesoIndex = headers.findIndex((h: string) => h === '"Data Sospeso"');
    expect(lines[1].split(';')[sospesoIndex]).toBe('""');
  });

  it('per uno stato ripetuto (Rimandato) registra la PRIMA occorrenza, non l\'ultima', () => {
    const csv = buildPostalReportStoricoCsv(baseReport);
    const lines = csv.split('\n');
    const headers = lines[0].split(';');
    const rimandatoIndex = headers.findIndex((h: string) => h === '"Data Rimandato"');
    const cell = lines[1].split(';')[rimandatoIndex];
    expect(cell).toContain(new Date('2026-01-12T10:00:00Z').toLocaleString('it-IT', { timeZone: 'Europe/Rome' }).split(',')[0]);
  });
});
