import { buildSendReportAttualeCsv, buildSendReportStoricoCsv } from './send-report-csv.util';
import type { SendReportDto } from './dto/campaign-stats.dto';

const baseReport: SendReportDto = {
  hasAppIoCoDelivery: false,
  rows: [{
    codiceFiscale: 'RSSMRA80A01H501U',
    fullName: 'Mario Rossi',
    iun: 'IUN-1',
    digitalDomicileType: 'PEC',
    digitalDomicileAddress: 'mario@pec.it',
    sendStatus: 'DELIVERED',
    sendStatusHistory: [
      { status: 'ACCEPTED', activeFrom: '2026-01-10T10:00:00Z' },
      { status: 'DELIVERED', activeFrom: '2026-01-12T09:00:00Z' },
    ],
    appIoOutcome: null,
  }],
};

describe('buildSendReportAttualeCsv', () => {
  it('include intestazioni e riga con stato/data correnti (ultimo elemento storico)', () => {
    const csv = buildSendReportAttualeCsv(baseReport);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"Codice Fiscale";"Nominativo";"IUN";"Tipo Domicilio Digitale";"Indirizzo Domicilio";"Stato";"Data Stato"');
    expect(lines[1]).toContain('"Consegnata"');
    expect(lines[1]).not.toContain('Esito App IO');
  });

  it('aggiunge la colonna Esito App IO solo se hasAppIoCoDelivery', () => {
    const report: SendReportDto = {
      hasAppIoCoDelivery: true,
      rows: [{ ...baseReport.rows[0], appIoOutcome: { success: true, error: null } }],
    };
    const csv = buildSendReportAttualeCsv(report);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('"Esito App IO"');
    expect(lines[1]).toContain('"Consegnato"');
  });

  it('mostra "Fallito: <errore>" per esito App IO negativo', () => {
    const report: SendReportDto = {
      hasAppIoCoDelivery: true,
      rows: [{ ...baseReport.rows[0], appIoOutcome: { success: false, error: 'servizio non attivo' } }],
    };
    const csv = buildSendReportAttualeCsv(report);
    expect(csv.split('\n')[1]).toContain('Fallito: servizio non attivo');
  });
});

describe('buildSendReportStoricoCsv', () => {
  it('include una colonna data per ciascuno dei 10 stati, vuota se mai raggiunto', () => {
    const csv = buildSendReportStoricoCsv(baseReport);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('"Data Accettazione"');
    expect(lines[0]).toContain('"Data Restituzione al Mittente"');
    expect(lines[0].split(';')).toHaveLength(5 + 10);
    // REFUSED mai raggiunto in questo fixture: colonna vuota.
    const cells = lines[1].split(';');
    const refusedIndex = lines[0].split(';').findIndex((h) => h === '"Data Rifiuto"');
    expect(cells[refusedIndex]).toBe('""');
  });
});
