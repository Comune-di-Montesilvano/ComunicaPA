import { describe, expect, it } from 'vitest';
import { buildSendPerfection } from './send-perfection.util.js';
import type { SendTimelineEvent } from '../channels/send/send-status-history.util.js';

const now = new Date('2026-11-06T10:00:00Z');
const ACCEPTED = { status: 'ACCEPTED', activeFrom: '2026-10-15T09:00:00Z' };
const DELIVERING = { status: 'DELIVERING', activeFrom: '2026-10-16T09:00:00Z' };
const UNREACHABLE = { status: 'UNREACHABLE', activeFrom: '2026-11-03T08:00:00Z' };
const irrHistory = [ACCEPTED, DELIVERING, UNREACHABLE];

const ev = (category: string, at: string, extra: Partial<SendTimelineEvent> = {}): SendTimelineEvent => ({
  category,
  at,
  details: {},
  ...extra,
});
const sched = (at: string, schedulingDate: string) => ev('SCHEDULE_REFINEMENT', at, { details: { schedulingDate } });

const keys = (p: ReturnType<typeof buildSendPerfection>) => p!.steps.map((s) => s.key);
const dates = (p: ReturnType<typeof buildSendPerfection>) => p!.steps.map((s) => s.date);
const step = (p: ReturnType<typeof buildSendPerfection>, k: string) => p!.steps.find((s) => s.key === k)!;

describe('buildSendPerfection', () => {
  it('irreperibile senza SCHEDULE_REFINEMENT', () => {
    const p = buildSendPerfection('UNREACHABLE', irrHistory, [], now);
    expect(keys(p)).toEqual(['entity', 'deposited', 'recipient']);
    expect(dates(p)).toEqual(['2026-10-15', '2026-11-03', '2026-11-13']);
    expect(p!.steps.map((s) => s.state)).toEqual(['done', 'ko', 'expected']);
    expect(p!.finalSource).toBe('estimate');
    expect(p!.finalDate).toBe('2026-11-13');
    expect(p!.today).toBe('2026-11-06');
    expect(step(p, 'recipient').offsetDays).toBe(10);
  });

  it('irreperibile con SCHEDULE_REFINEMENT', () => {
    const tl = [sched('2026-11-04T10:00:00Z', '2026-11-20T10:00:00Z'), sched('2026-11-05T10:00:00Z', '2026-11-24T10:00:00Z')];
    const p = buildSendPerfection('UNREACHABLE', irrHistory, tl, now);
    expect(p!.finalDate).toBe('2026-11-24');
    expect(p!.finalSource).toBe('pn_scheduled');
    expect(step(p, 'recipient').offsetDays).toBeUndefined();
    expect(step(p, 'recipient').state).toBe('expected');
  });

  it('irreperibile perfezionata', () => {
    const h = [...irrHistory, { status: 'EFFECTIVE_DATE', activeFrom: '2026-11-23T05:00:00Z' }];
    const tl = [sched('2026-11-05T10:00:00Z', '2026-11-24T10:00:00Z')];
    const p = buildSendPerfection('EFFECTIVE_DATE', h, tl, now);
    expect(p!.finalSource).toBe('pn');
    expect(p!.finalDate).toBe('2026-11-23');
    expect(step(p, 'recipient').state).toBe('done');
  });

  describe('caso reale: irreperibile totale perfezionata a deposito + 10', () => {
    const realHistory = [
      { status: 'ACCEPTED', activeFrom: '2026-09-09T08:42:00Z' },
      { status: 'DELIVERING', activeFrom: '2026-09-09T09:00:00Z' },
      { status: 'UNREACHABLE', activeFrom: '2026-10-17T02:45:43Z' },
    ];
    const realTl = [
      ev('COMPLETELY_UNREACHABLE', '2026-10-17T02:45:43Z'),
      sched('2026-10-17T02:45:44Z', '2026-10-27T02:45:43Z'),
    ];
    const realNow = new Date('2026-10-20T10:00:00Z');

    it('programmata da PN', () => {
      const p = buildSendPerfection('UNREACHABLE', realHistory, realTl, realNow);
      expect(p!.finalSource).toBe('pn_scheduled');
      expect(p!.finalDate).toBe('2026-10-27');
      expect(keys(p)).toEqual(['entity', 'deposited', 'recipient']);
    });

    it('effettiva da PN', () => {
      const h = [...realHistory, { status: 'EFFECTIVE_DATE', activeFrom: '2026-10-27T02:45:43Z' }];
      const tl = [...realTl, ev('REFINEMENT', '2026-10-27T02:45:43Z')];
      const p = buildSendPerfection('EFFECTIVE_DATE', h, tl, new Date('2026-11-01T10:00:00Z'));
      expect(p!.finalSource).toBe('pn');
      expect(p!.finalDate).toBe('2026-10-27');
      expect(step(p, 'recipient').state).toBe('done');
    });
  });

  it('REFINEMENT senza EFFECTIVE_DATE in history', () => {
    const p = buildSendPerfection('UNREACHABLE', irrHistory, [ev('REFINEMENT', '2026-11-22T10:00:00Z')], now);
    expect(p!.finalSource).toBe('pn');
    expect(p!.finalDate).toBe('2026-11-22');
  });

  it('irreperibile da COMPLETELY_UNREACHABLE nella timeline', () => {
    const p = buildSendPerfection(null, [ACCEPTED], [ev('COMPLETELY_UNREACHABLE', '2026-11-03T08:00:00Z')], now);
    expect(keys(p)).toEqual(['entity', 'deposited', 'recipient']);
    expect(step(p, 'deposited').date).toBe('2026-11-03');
  });

  it('digitale consegnato alle 21:30 ora italiana', () => {
    const p = buildSendPerfection('DELIVERED', [ACCEPTED], [ev('SEND_DIGITAL_FEEDBACK', '2026-11-03T20:30:00Z', { responseStatus: 'OK' })], now);
    expect(step(p, 'digital_delivered').date).toBe('2026-11-03');
    expect(p!.finalDate).toBe('2026-11-11');
    expect(step(p, 'recipient').offsetDays).toBe(7);
  });

  it('digitale consegnato alle 21:00:00 esatte', () => {
    const p = buildSendPerfection('DELIVERED', [ACCEPTED], [ev('SEND_DIGITAL_FEEDBACK', '2026-11-03T20:00:00Z', { responseStatus: 'OK' })], now);
    expect(p!.finalDate).toBe('2026-11-10');
  });

  it('digitale fallito', () => {
    const p = buildSendPerfection('DELIVERING', [ACCEPTED], [ev('DIGITAL_FAILURE_WORKFLOW', '2026-11-02T10:00:00Z')], now);
    expect(keys(p)).toEqual(['entity', 'digital_failure', 'recipient']);
    expect(p!.finalDate).toBe('2026-11-17');
    expect(step(p, 'recipient').offsetDays).toBe(15);
  });

  it('cartaceo consegnato', () => {
    const p = buildSendPerfection('DELIVERED', [ACCEPTED], [ev('SEND_ANALOG_FEEDBACK', '2026-11-02T10:00:00Z', { responseStatus: 'OK' })], now);
    expect(keys(p)).toEqual(['entity', 'analog_delivered', 'recipient']);
    expect(p!.finalSource).toBe('none');
    expect(step(p, 'recipient').date).toBeNull();
    expect(step(p, 'recipient').state).toBe('expected');
  });

  it('in lavorazione', () => {
    const p = buildSendPerfection('DELIVERING', [ACCEPTED, DELIVERING], [], now);
    expect(keys(p)).toEqual(['entity', 'delivering', 'recipient']);
    expect(step(p, 'delivering').date).toBe('2026-10-16');
    expect(step(p, 'delivering').state).toBe('done');
    expect(p!.finalSource).toBe('none');
  });

  it('accettata, raccomandata programmata da PN: "In consegna" prevista a quella data', () => {
    const probable = (at: string, d: string) => ev('PROBABLE_SCHEDULING_ANALOG_DATE', at, { details: { recIndex: 0, schedulingAnalogDate: d } });
    const tl = [probable('2026-11-05T11:51:00Z', '2026-11-10T11:51:00Z')];
    const p = buildSendPerfection('ACCEPTED', [ACCEPTED], tl, now);
    expect(keys(p)).toEqual(['entity', 'delivering', 'recipient']);
    expect(step(p, 'delivering').date).toBe('2026-11-10');
    expect(step(p, 'delivering').state).toBe('expected');
    // Data già passata senza che parta la raccomandata: non più affidabile.
    const late = buildSendPerfection('ACCEPTED', [ACCEPTED], [probable('2026-10-30T11:51:00Z', '2026-11-04T11:51:00Z')], now);
    expect(step(late, 'delivering').date).toBeNull();
    // Già in consegna: vale la data dello storico PN.
    const started = buildSendPerfection('DELIVERING', [ACCEPTED, DELIVERING], tl, now);
    expect(step(started, 'delivering').date).toBe('2026-10-16');
    expect(step(started, 'delivering').state).toBe('done');
  });

  it('letta su SEND senza mai passare da DELIVERING: niente tappa "In consegna" vuota', () => {
    const p = buildSendPerfection('VIEWED', [ACCEPTED, { status: 'VIEWED', activeFrom: '2026-10-15T09:48:00Z' }], [], now);
    expect(keys(p)).toEqual(['entity', 'viewed', 'recipient']);
    expect(dates(p)).toEqual(['2026-10-15', '2026-10-15', '2026-10-15']);
    expect(p!.finalSource).toBe('pn');
  });

  it('VIEWED prima della data programmata', () => {
    const h = [...irrHistory, { status: 'VIEWED', activeFrom: '2026-11-05T09:00:00Z' }];
    const p = buildSendPerfection('VIEWED', h, [sched('2026-11-04T10:00:00Z', '2026-11-24T10:00:00Z')], now);
    expect(p!.finalSource).toBe('pn');
    expect(p!.finalDate).toBe('2026-11-05');
    expect(keys(p)).toEqual(['entity', 'deposited', 'viewed', 'recipient']);
  });

  it('VIEWED dopo il perfezionamento: tappa esclusa, date in ordine', () => {
    const h = [
      ...irrHistory,
      { status: 'EFFECTIVE_DATE', activeFrom: '2026-11-23T05:00:00Z' },
      { status: 'VIEWED', activeFrom: '2026-11-30T09:00:00Z' },
    ];
    const p = buildSendPerfection('VIEWED', h, [], now);
    expect(p!.finalSource).toBe('pn');
    expect(p!.finalDate).toBe('2026-11-23');
    expect(keys(p)).toEqual(['entity', 'deposited', 'recipient']);
    const ds = dates(p).filter((d): d is string => d !== null);
    expect([...ds].sort()).toEqual(ds);
  });

  it('pn_scheduled prima della stima: vince la data di PN', () => {
    const p = buildSendPerfection('UNREACHABLE', irrHistory, [sched('2026-11-04T10:00:00Z', '2026-11-10T10:00:00Z')], now);
    expect(p!.finalSource).toBe('pn_scheduled');
    expect(p!.finalDate).toBe('2026-11-10');
    expect(keys(p)).toEqual(['entity', 'deposited', 'recipient']);
  });

  it('SEND_DIGITAL_FEEDBACK senza responseStatus non è consegna', () => {
    const p = buildSendPerfection('DELIVERING', [ACCEPTED, DELIVERING], [ev('SEND_DIGITAL_FEEDBACK', '2026-11-03T10:00:00Z')], now);
    expect(keys(p)).toEqual(['entity', 'delivering', 'recipient']);
    expect(p!.finalSource).toBe('none');
  });

  it('REFUSED', () => {
    expect(buildSendPerfection('REFUSED', [{ status: 'REFUSED', activeFrom: '2026-10-15T09:00:00Z' }], [], now)).toBeNull();
    expect(buildSendPerfection(null, [{ status: 'REFUSED', activeFrom: '2026-10-15T09:00:00Z' }], [], now)).toBeNull();
  });

  it('CANCELLED', () => {
    expect(buildSendPerfection('CANCELLED', [ACCEPTED], [], now)).toBeNull();
    expect(buildSendPerfection(null, [ACCEPTED, { status: 'CANCELLED', activeFrom: '2026-10-20T09:00:00Z' }], [], now)).toBeNull();
  });

  it('input nulli', () => {
    const p = buildSendPerfection(null, null, null, now);
    expect(p).not.toBeNull();
    expect(keys(p)).toEqual(['entity', 'delivering', 'recipient']);
    expect(step(p, 'entity').date).toBeNull();
    expect(step(p, 'entity').state).toBe('expected');
  });

  it('evento senza at valido ignorato', () => {
    const p = buildSendPerfection('DELIVERING', [ACCEPTED, DELIVERING], [ev('SEND_DIGITAL_FEEDBACK', 'x', { responseStatus: 'OK' })], now);
    expect(keys(p)).toEqual(['entity', 'delivering', 'recipient']);
  });

  it('digitale oltre le 21:00 con ora legale (CEST)', () => {
    const p = buildSendPerfection('DELIVERED', [ACCEPTED], [ev('SEND_DIGITAL_FEEDBACK', '2026-10-20T19:00:01Z', { responseStatus: 'OK' })], now);
    expect(step(p, 'digital_delivered').date).toBe('2026-10-20');
    expect(p!.finalDate).toBe('2026-10-28');
  });

  it('cambio giorno a Roma dopo mezzanotte', () => {
    const p = buildSendPerfection('DELIVERED', [ACCEPTED], [ev('SEND_DIGITAL_FEEDBACK', '2026-11-03T23:30:00Z', { responseStatus: 'OK' })], now);
    expect(step(p, 'digital_delivered').date).toBe('2026-11-04');
    expect(p!.finalDate).toBe('2026-11-11');
  });

  it('DIGITAL_SUCCESS_WORKFLOW da solo', () => {
    const p = buildSendPerfection('DELIVERED', [ACCEPTED], [ev('DIGITAL_SUCCESS_WORKFLOW', '2026-11-03T10:00:00Z')], now);
    expect(keys(p)).toEqual(['entity', 'digital_delivered', 'recipient']);
  });

  it('ANALOG_SUCCESS_WORKFLOW da solo', () => {
    const p = buildSendPerfection('DELIVERED', [ACCEPTED], [ev('ANALOG_SUCCESS_WORKFLOW', '2026-11-03T10:00:00Z')], now);
    expect(keys(p)).toEqual(['entity', 'analog_delivered', 'recipient']);
    expect(p!.finalSource).toBe('none');
  });

  it('SEND_DIGITAL_FEEDBACK KO da solo resta in consegna', () => {
    const p = buildSendPerfection('DELIVERING', [ACCEPTED, DELIVERING], [ev('SEND_DIGITAL_FEEDBACK', '2026-11-03T10:00:00Z', { responseStatus: 'KO' })], now);
    expect(keys(p)).toEqual(['entity', 'delivering', 'recipient']);
  });
});
