import { buildPostalReportAttualeCsv, buildPostalReportStoricoCsv } from './postal-report-csv.util.js';
import type { PostalReportDto } from './dto/campaign-stats.dto.js';

const baseReport: PostalReportDto = {
  hasAppIoCoDelivery: false,
  hasExternalId: false,
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
    externalId: null,
    posteVerification: null,
    posteDiscrepancy: false,
  }],
};

describe('buildPostalReportAttualeCsv', () => {
  it('include intestazioni e riga con stato/data correnti (ultimo elemento storico)', () => {
    const csv = buildPostalReportAttualeCsv(baseReport);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"Codice Fiscale";"Nominativo";"IDPRO";"Stato Documento";"Data Stato";"Stato Consegna Poste";"Codice Consegna";"Data Consegna Poste";"ID Accettazione Poste";"Codice Errore";"Descrizione Errore";"Verifica Poste";"Sintesi Poste";"Data Esito Poste";"Ultimo Movimento Poste";"Discrepanza GlobalCom/Poste"');
    expect(lines[1]).toContain('"Consegnato"');
    expect(lines[1]).not.toContain('Esito App IO');
  });

  it('aggiunge la colonna Esito App IO solo se hasAppIoCoDelivery', () => {
    const report: PostalReportDto = {
      hasAppIoCoDelivery: true,
      hasExternalId: false,
      rows: [{ ...baseReport.rows[0], appIoOutcome: { success: true, error: null } }],
    };
    const csv = buildPostalReportAttualeCsv(report);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('"Esito App IO"');
    expect(lines[1]).toContain('"Consegnato"');
  });

  it('aggiunge la colonna External ID quando hasExternalId è true', () => {
    const report: PostalReportDto = {
      hasAppIoCoDelivery: false,
      hasExternalId: true,
      rows: [{ ...baseReport.rows[0], externalId: '5890000000049995' }],
    };
    const csv = buildPostalReportAttualeCsv(report);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('"External ID"');
    expect(lines[1]).toContain('"5890000000049995"');
  });
});

describe('buildPostalReportStoricoCsv', () => {
  it('include una colonna data per ciascuno dei 14 stati, vuota se mai raggiunto', () => {
    const csv = buildPostalReportStoricoCsv(baseReport);
    const lines = csv.split('\n');
    expect(lines[0].split(';')).toHaveLength(9 + 14 + 5);
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

describe('colonne verifica Poste', () => {
  const when = new Date('2026-09-04T08:06:00.000Z').toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
  const discrepancyReport: PostalReportDto = {
    hasAppIoCoDelivery: true,
    hasExternalId: false,
    rows: [{
      ...baseReport.rows[0]!,
      postalStatus: 'NonConsegnato',
      postalDeliveryStatus: 'Indirizzo errato o inesatto',
      appIoOutcome: { success: true, error: null },
      posteVerification: { status: 'delivered', checkCount: 3, trackingUntil: '2026-10-27T18:05:03.000Z', deliveredAt: '2026-09-04T08:06:00.000Z', outcomeAt: '2026-09-04T08:06:00.000Z', lastMovement: `SVIZZERA ${when}`, summary: 'La spedizione è stata consegnata' },
      posteDiscrepancy: true,
    }],
  };

  it('attuale: valori e posizione prima di Esito App IO', () => {
    const [header, line] = buildPostalReportAttualeCsv(discrepancyReport).split('\n');
    expect(header).toContain('"Discrepanza GlobalCom/Poste";"Esito App IO"');
    expect(line).toContain(`"Consegnato";"La spedizione è stata consegnata";"${when}";"SVIZZERA ${when}";"SI";"Consegnato"`);
  });

  it('storico: stesse colonne', () => {
    const [header, line] = buildPostalReportStoricoCsv(discrepancyReport).split('\n');
    expect(header).toContain('"Verifica Poste";"Sintesi Poste";"Data Esito Poste";"Ultimo Movimento Poste";"Discrepanza GlobalCom/Poste"');
    expect(line).toContain('"SI"');
  });

  it('senza verifica: celle vuote, nessuna discrepanza', () => {
    const line = buildPostalReportAttualeCsv(baseReport).split('\n')[1]!;
    expect(line.endsWith('"";"";"";"";""')).toBe(true);
  });
});
