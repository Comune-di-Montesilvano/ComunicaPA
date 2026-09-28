import { sendLegalDateOf } from './send-legal-date.util.js';

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
