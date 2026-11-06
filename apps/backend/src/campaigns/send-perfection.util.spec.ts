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
    expect(keys(p)).toEqual(['entity', 'deposited', 'aar_refined', 'recipient']);
    expect(dates(p)).toEqual(['2026-10-15', '2026-11-03', '2026-11-13', '2026-11-23']);
    expect(p!.steps.map((s) => s.state)).toEqual(['done', 'ko', 'expected', 'expected']);
    expect(p!.finalSource).toBe('estimate');
    expect(p!.finalDate).toBe('2026-11-23');
    expect(p!.today).toBe('2026-11-06');
    expect(step(p, 'aar_refined').offsetDays).toBe(10);
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
    expect(step(p, 'aar_refined').state).toBe('done');
    expect(step(p, 'recipient').state).toBe('done');
  });

  it('REFINEMENT senza EFFECTIVE_DATE in history', () => {
    const p = buildSendPerfection('UNREACHABLE', irrHistory, [ev('REFINEMENT', '2026-11-22T10:00:00Z')], now);
    expect(p!.finalSource).toBe('pn');
    expect(p!.finalDate).toBe('2026-11-22');
  });

  it('irreperibile da COMPLETELY_UNREACHABLE nella timeline', () => {
    const p = buildSendPerfection(null, [ACCEPTED], [ev('COMPLETELY_UNREACHABLE', '2026-11-03T08:00:00Z')], now);
    expect(keys(p)).toEqual(['entity', 'deposited', 'aar_refined', 'recipient']);
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

  it('VIEWED prima della data programmata', () => {
    const h = [...irrHistory, { status: 'VIEWED', activeFrom: '2026-11-05T09:00:00Z' }];
    const p = buildSendPerfection('VIEWED', h, [sched('2026-11-04T10:00:00Z', '2026-11-24T10:00:00Z')], now);
    expect(p!.finalSource).toBe('pn');
    expect(p!.finalDate).toBe('2026-11-05');
    expect(keys(p)).toEqual(['entity', 'deposited', 'aar_refined', 'viewed', 'recipient']);
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
});
