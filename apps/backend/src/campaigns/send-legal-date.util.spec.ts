import { sendDocumentsAvailableUntil, sendEntityLegalDateOf, sendLegalDateOf } from './send-legal-date.util.js';

describe('sendLegalDateOf', () => {
  it('perfezionamento per presa visione: VIEWED prima di EFFECTIVE_DATE', () => {
    expect(sendLegalDateOf([
      { status: 'ACCEPTED', activeFrom: '2026-09-01T10:00:00Z' },
      { status: 'DELIVERED', activeFrom: '2026-09-01T11:00:00Z' },
      { status: 'VIEWED', activeFrom: '2026-09-03T08:00:00Z' },
      { status: 'EFFECTIVE_DATE', activeFrom: '2026-09-08T11:00:00Z' },
    ])).toBe('2026-09-03T08:00:00Z');
  });

  it('perfezionamento per decorrenza termini: EFFECTIVE_DATE prima della presa visione', () => {
    expect(sendLegalDateOf([
      { status: 'DELIVERED', activeFrom: '2026-09-01T11:00:00Z' },
      { status: 'EFFECTIVE_DATE', activeFrom: '2026-09-08T11:00:00Z' },
      { status: 'VIEWED', activeFrom: '2026-09-20T09:00:00Z' },
    ])).toBe('2026-09-08T11:00:00Z');
  });

  it('non ancora perfezionata (consegnata/in consegna, irreperibile, annullata) → null', () => {
    expect(sendLegalDateOf([{ status: 'DELIVERED', activeFrom: '2026-09-01T11:00:00Z' }])).toBeNull();
    expect(sendLegalDateOf([{ status: 'UNREACHABLE', activeFrom: '2026-09-01T11:00:00Z' }])).toBeNull();
    expect(sendLegalDateOf(null)).toBeNull();
    expect(sendLegalDateOf([])).toBeNull();
  });
});

describe('sendEntityLegalDateOf', () => {
  it("messa a disposizione = ACCEPTED, anche se poi irreperibile (art. 26 c. 9 lett. a)", () => {
    expect(sendEntityLegalDateOf([
      { status: 'ACCEPTED', activeFrom: '2026-09-09T08:26:00Z' },
      { status: 'DELIVERING', activeFrom: '2026-09-14T08:32:00Z' },
      { status: 'UNREACHABLE', activeFrom: '2026-10-02T09:01:00Z' },
      { status: 'EFFECTIVE_DATE', activeFrom: '2026-10-12T09:01:00Z' },
    ])).toBe('2026-09-09T08:26:00Z');
  });

  it('mai accettata (rifiutata, in validazione) o annullata → null', () => {
    expect(sendEntityLegalDateOf([{ status: 'IN_VALIDATION', activeFrom: '2026-09-01T10:00:00Z' }, { status: 'REFUSED', activeFrom: '2026-09-01T10:05:00Z' }])).toBeNull();
    expect(sendEntityLegalDateOf([{ status: 'ACCEPTED', activeFrom: '2026-09-01T10:00:00Z' }, { status: 'CANCELLED', activeFrom: '2026-09-02T10:00:00Z' }])).toBeNull();
    expect(sendEntityLegalDateOf(null)).toBeNull();
  });
});

describe('sendDocumentsAvailableUntil', () => {
  it('data legale + 120 giorni', () => {
    const history = [
      { status: 'DELIVERED', activeFrom: '2026-01-01T10:00:00Z' },
      { status: 'VIEWED', activeFrom: '2026-01-02T10:00:00Z' },
    ];
    expect(sendDocumentsAvailableUntil(history)?.toISOString()).toBe('2026-05-02T10:00:00.000Z');
  });

  it('notifica senza valore legale → null', () => {
    expect(sendDocumentsAvailableUntil([{ status: 'DELIVERING', activeFrom: '2026-01-01T10:00:00Z' }])).toBeNull();
    expect(sendDocumentsAvailableUntil(null)).toBeNull();
  });
});
