import { extractSendStatusHistory, extractSendDigitalDomicile } from './send-status-history.util';

describe('extractSendStatusHistory', () => {
  it('mappa notificationStatusHistory in {status, activeFrom}', () => {
    const data = {
      notificationStatusHistory: [
        { status: 'ACCEPTED', activeFrom: '2026-01-10T10:00:00Z', relatedTimelineElements: ['el-1'] },
        { status: 'DELIVERED', activeFrom: '2026-01-12T09:00:00Z', relatedTimelineElements: ['el-2'] },
      ],
    };
    expect(extractSendStatusHistory(data)).toEqual([
      { status: 'ACCEPTED', activeFrom: '2026-01-10T10:00:00Z' },
      { status: 'DELIVERED', activeFrom: '2026-01-12T09:00:00Z' },
    ]);
  });

  it('ritorna array vuoto se notificationStatusHistory è assente', () => {
    expect(extractSendStatusHistory({})).toEqual([]);
  });
});

describe('extractSendDigitalDomicile', () => {
  it('estrae domicilio digitale da evento SEND_DIGITAL_DOMICILE', () => {
    const data = {
      timeline: [
        { category: 'PREPARE_DIGITAL_DOMICILE', details: {} },
        {
          category: 'SEND_DIGITAL_DOMICILE',
          details: {
            digitalAddress: { type: 'PEC', address: 'mario.rossi@pec.it' },
            digitalAddressSource: 'PLATFORM',
          },
        },
      ],
    };
    expect(extractSendDigitalDomicile(data)).toEqual({ type: 'PEC', address: 'mario.rossi@pec.it', source: 'PLATFORM' });
  });

  it('un evento SEND_ANALOG_DOMICILE successivo (fallback cartaceo) sovrascrive il digitale precedente', () => {
    const data = {
      timeline: [
        {
          category: 'SEND_DIGITAL_DOMICILE',
          details: { digitalAddress: { type: 'PEC', address: 'x@pec.it' }, digitalAddressSource: 'PLATFORM' },
        },
        { category: 'SEND_ANALOG_DOMICILE', details: {} },
      ],
    };
    expect(extractSendDigitalDomicile(data)).toEqual({ type: 'CARTACEO', address: null, source: 'ANALOG' });
  });

  it('ritorna null se timeline è assente o senza eventi di domicilio', () => {
    expect(extractSendDigitalDomicile({})).toBeNull();
    expect(extractSendDigitalDomicile({ timeline: [{ category: 'SEND_DIGITAL_FEEDBACK', details: {} }] })).toBeNull();
  });
});
