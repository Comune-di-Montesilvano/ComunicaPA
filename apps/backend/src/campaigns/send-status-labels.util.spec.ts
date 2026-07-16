import { sendStatusLabel, digitalDomicileTypeLabel, SEND_STATUS_HISTORY_COLUMNS } from './send-status-labels.util';

describe('sendStatusLabel', () => {
  it('traduce uno stato PN noto', () => {
    expect(sendStatusLabel('VIEWED')).toBe('Letta dal destinatario');
  });
  it('ritorna "In attesa accettazione" per null', () => {
    expect(sendStatusLabel(null)).toBe('In attesa accettazione');
  });
  it('ritorna il valore grezzo per uno stato non mappato', () => {
    expect(sendStatusLabel('NUOVO_STATO_MAI_VISTO')).toBe('NUOVO_STATO_MAI_VISTO');
  });
});

describe('digitalDomicileTypeLabel', () => {
  it('traduce PEC', () => {
    expect(digitalDomicileTypeLabel('PEC')).toBe('PEC');
  });
  it('traduce APPIO in "App IO"', () => {
    expect(digitalDomicileTypeLabel('APPIO')).toBe('App IO');
  });
  it('traduce CARTACEO in "Raccomandata cartacea"', () => {
    expect(digitalDomicileTypeLabel('CARTACEO')).toBe('Raccomandata cartacea');
  });
  it('ritorna stringa vuota per null', () => {
    expect(digitalDomicileTypeLabel(null)).toBe('');
  });
});

describe('SEND_STATUS_HISTORY_COLUMNS', () => {
  it('contiene 10 colonne, PAID escluso', () => {
    expect(SEND_STATUS_HISTORY_COLUMNS).toHaveLength(10);
    expect(SEND_STATUS_HISTORY_COLUMNS.find((c) => c.status === 'PAID')).toBeUndefined();
  });
});
