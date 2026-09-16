import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PresenceService } from './presence.service.js';

describe('PresenceService', () => {
  let service: PresenceService;

  beforeEach(() => {
    service = new PresenceService();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('conta un operatore che ha fatto heartbeat come online', () => {
    service.heartbeat('mrossi');
    expect(service.getOnlineCount()).toBe(1);
  });

  it('conta operatori distinti una sola volta ciascuno', () => {
    service.heartbeat('mrossi');
    service.heartbeat('mrossi');
    service.heartbeat('averdi');
    expect(service.getOnlineCount()).toBe(2);
  });

  it('non conta un operatore il cui ultimo heartbeat supera 90 secondi', () => {
    service.heartbeat('mrossi');
    vi.setSystemTime(new Date('2026-09-16T10:01:31.000Z')); // +91s
    expect(service.getOnlineCount()).toBe(0);
  });

  it('conta un operatore al limite della soglia (90s esatti)', () => {
    service.heartbeat('mrossi');
    vi.setSystemTime(new Date('2026-09-16T10:01:30.000Z')); // +90s esatti
    expect(service.getOnlineCount()).toBe(1);
  });
});
