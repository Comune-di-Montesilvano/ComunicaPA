import { buildNotificationStatus, type StatusInput } from './external-notification-status.js';

const T0 = new Date('2026-10-01T10:00:00Z');
const T1 = new Date('2026-10-01T10:05:00Z');

function input(over: Partial<StatusInput> = {}): StatusInput {
  return {
    recipient: { id: 'rec-1', createdAt: T0, status: 'sent', codiceFiscale: 'RSSMRA80A01H501U', inadCheck: null },
    campaign: { status: 'completed', channelType: 'EMAIL', channelConfig: { source: 'external', externalReference: 'PROT-1' } },
    attempt: null,
    poste: null,
    ...over,
  };
}

function attempt(over: Record<string, unknown> = {}) {
  return {
    status: 'success', channelType: 'EMAIL', sentAt: T1, errorMessage: null, iun: null, sendStatus: null, sendStatusHistory: null,
    protocolNumber: null, protocolYear: null, protocolledAt: null, postalTrackingId: null, postalStatus: null, postalStatusHistory: null,
    postalDeliveryStatus: null, postalDeliveryDate: null, costCents: null, responsePayload: null,
    ...over,
  } as any;
}

describe('buildNotificationStatus', () => {
  it('nessun attempt → accepted, evento accepted', () => {
    const s = buildNotificationStatus(input({ campaign: { status: 'queued', channelType: 'EMAIL', channelConfig: {} } }));
    expect(s).toEqual(expect.objectContaining({
      success: true, notificationId: 'rec-1', externalReference: null, requestedChannel: 'EMAIL', effectiveChannel: 'EMAIL',
      diversion: null, status: 'accepted', error: null, costCents: null,
    }));
    expect(s.events.map((e) => e.type)).toEqual(['accepted']);
    expect(s).not.toHaveProperty('legal');
    expect(s).not.toHaveProperty('send');
  });

  it('campagna checking_inad → checking; destinatario pending_review → pending_review', () => {
    expect(buildNotificationStatus(input({ campaign: { status: 'checking_inad', channelType: 'PEC', channelConfig: {} } })).status).toBe('checking');
    const s = buildNotificationStatus(input({
      recipient: { id: 'rec-1', createdAt: T0, status: 'pending_review', codiceFiscale: '01234567890',
        inadCheck: { found: true, diverted: true, originalChannel: 'PEC', originalAddress: 'vecchia@pec.it', foundAddress: 'nuova@pec.it', checkedAt: T1.toISOString() } },
      campaign: { status: 'running', channelType: 'PEC', channelConfig: {} },
    }));
    expect(s.status).toBe('pending_review');
    expect(s.events.map((e) => e.type)).toEqual(['accepted', 'pending_review']);
  });

  it('EMAIL inviata → sent, mai delivered', () => {
    const s = buildNotificationStatus(input({ attempt: attempt() }));
    expect(s.status).toBe('sent');
    expect(s.events.map((e) => e.type)).toEqual(['accepted', 'sent']);
  });

  it('attempt queued → in_progress; failed → failed con errore', () => {
    expect(buildNotificationStatus(input({ attempt: attempt({ status: 'queued', sentAt: null }) })).status).toBe('in_progress');
    const f = buildNotificationStatus(input({ attempt: attempt({ status: 'failed', sentAt: null, errorMessage: 'SMTP 550' }) }));
    expect(f).toEqual(expect.objectContaining({ status: 'failed', error: 'SMTP 550' }));
    expect(f.events.at(-1)).toEqual(expect.objectContaining({ type: 'failed', data: { error: 'SMTP 550' } }));
  });

  it('SEND perfezionata → delivered con IUN, data legale, protocollo, eventi send_status', () => {
    const s = buildNotificationStatus(input({
      campaign: { status: 'completed', channelType: 'SEND', channelConfig: {} },
      attempt: attempt({
        channelType: 'SEND', iun: 'ABCD-EFGH-IJKL-202610-M-1', sendStatus: 'VIEWED', protocolNumber: 123, protocolYear: 2026, protocolledAt: T0, costCents: 850,
        sendStatusHistory: [
          { status: 'ACCEPTED', activeFrom: '2026-10-01T11:00:00Z' },
          { status: 'VIEWED', activeFrom: '2026-10-03T09:00:00Z' },
        ],
      }),
    }));
    expect(s.status).toBe('delivered');
    expect(s.legal).toEqual({ outcome: 'delivered', at: '2026-10-03T09:00:00Z', reason: 'VIEWED' });
    expect(s.send).toEqual({ iun: 'ABCD-EFGH-IJKL-202610-M-1', status: 'VIEWED', legalDate: '2026-10-03T09:00:00Z', protocol: { number: 123, year: 2026, at: T0.toISOString() } });
    expect(s.costCents).toBe(850);
    expect(s.events.filter((e) => e.type === 'send_status').map((e) => e.data)).toEqual([{ status: 'ACCEPTED' }, { status: 'VIEWED' }]);
  });

  it('SEND UNREACHABLE → not_delivered', () => {
    const s = buildNotificationStatus(input({
      campaign: { status: 'completed', channelType: 'SEND', channelConfig: {} },
      attempt: attempt({ channelType: 'SEND', sendStatus: 'UNREACHABLE', sendStatusHistory: [{ status: 'UNREACHABLE', activeFrom: '2026-10-05T00:00:00Z' }] }),
    }));
    expect(s.status).toBe('not_delivered');
    expect(s.legal).toEqual({ outcome: 'not_delivered', at: null, reason: 'UNREACHABLE' });
  });

  it('POSTAL Raccomandata AR consegnata → delivered con data consegna', () => {
    const s = buildNotificationStatus(input({
      campaign: { status: 'completed', channelType: 'POSTAL', channelConfig: { postalServiceType: 'Raccomandata', postalReturnReceipt: true } },
      attempt: attempt({ channelType: 'POSTAL', postalTrackingId: 'ID1', postalStatus: 'Consegnato', postalDeliveryStatus: 'Consegnato a Domicilio', postalDeliveryDate: T1,
        postalStatusHistory: [{ stato: 'Accettato', rilevatoIl: '2026-10-01T12:00:00Z', codiceErrore: '0' }] }),
    }));
    expect(s.status).toBe('delivered');
    expect(s.legal).toEqual({ outcome: 'delivered', at: T1.toISOString(), reason: 'Consegnato a Domicilio' });
    expect(s.postal).toEqual({ trackingId: 'ID1', status: 'Consegnato', deliveryStatus: 'Consegnato a Domicilio', deliveryDate: T1.toISOString() });
  });

  it('POSTAL dirottata a PEC da INAD → effectiveChannel PEC, diversion INAD, esito dal ramo dirottato', () => {
    const s = buildNotificationStatus(input({
      recipient: { id: 'rec-1', createdAt: T0, status: 'sent', codiceFiscale: 'RSSMRA80A01H501U',
        inadCheck: { found: true, diverted: true, originalChannel: 'POSTAL', originalAddress: null, checkedAt: T0.toISOString() } },
      campaign: { status: 'completed', channelType: 'POSTAL', channelConfig: { postalServiceType: 'Raccomandata' } },
      attempt: attempt({ channelType: 'PEC' }),
    }));
    expect(s.requestedChannel).toBe('POSTAL');
    expect(s.effectiveChannel).toBe('PEC');
    expect(s.diversion).toEqual({ source: 'INAD' });
    expect(s.legal).toEqual({ outcome: 'delivered', at: T1.toISOString(), reason: 'Via PEC' });
    expect(s.status).toBe('delivered');
    expect(s).not.toHaveProperty('postal');
    expect(s.events.map((e) => e.type)).toEqual(['accepted', 'diverted', 'sent']);
  });

  it('PG dirottata → diversion REGISTRO_IMPRESE', () => {
    const s = buildNotificationStatus(input({
      recipient: { id: 'rec-1', createdAt: T0, status: 'sent', codiceFiscale: '01234567890',
        inadCheck: { found: true, diverted: true, originalChannel: 'EMAIL', originalAddress: 'a@b.it', checkedAt: T0.toISOString() } },
      attempt: attempt({ channelType: 'PEC' }),
    }));
    expect(s.diversion).toEqual({ source: 'REGISTRO_IMPRESE' });
    expect(s.legal).toEqual({ outcome: 'delivered', at: T1.toISOString(), reason: 'Via PEC' });
    expect(s.status).toBe('delivered');
  });

  it('App IO parallela riportata dal responsePayload', () => {
    const s = buildNotificationStatus(input({ campaign: { status: 'completed', channelType: 'EMAIL', channelConfig: { secondaryChannels: [{ channel: 'APP_IO' }] } }, attempt: attempt({ responsePayload: { appIo: { success: true } } }) }));
    expect(s.appIoParallel).toEqual({ success: true });
  });

  it('id evento stabile tra due letture, eventi ordinati per at', () => {
    const i = input({ attempt: attempt() });
    const a = buildNotificationStatus(i).events;
    const b = buildNotificationStatus(i).events;
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
    expect(a.map((e) => e.at)).toEqual([...a.map((e) => e.at)].sort());
  });
});
