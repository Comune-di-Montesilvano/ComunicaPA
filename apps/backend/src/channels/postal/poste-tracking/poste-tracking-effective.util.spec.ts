import { describe, it, expect } from 'vitest';
import { POSTE_DELIVERED_BUCKET, isPosteDeliveredOverride, posteDeliveredSql, posteVerificationLabel, formatLastMovement, toPosteVerificationDto } from './poste-tracking-effective.util.js';

describe('poste-tracking-effective', () => {
  it('override solo con GlobalCom NonConsegnato e Poste delivered', () => {
    expect(POSTE_DELIVERED_BUCKET).toBe('ConsegnatoVerificaPoste');
    expect(isPosteDeliveredOverride('NonConsegnato', 'delivered')).toBe(true);
    expect(isPosteDeliveredOverride('Consegnato', 'delivered')).toBe(false);
    expect(isPosteDeliveredOverride('NonConsegnato', 'returned')).toBe(false);
    expect(isPosteDeliveredOverride('NonConsegnato', null)).toBe(false);
  });

  it('SQL sull\'alias passato', () => {
    const sql = posteDeliveredSql('na');
    expect(sql).toContain("na.postal_status = 'NonConsegnato'");
    expect(sql).toContain('ppt.attempt_id = na.id');
    expect(sql).toContain("ppt.status = 'delivered'");
  });

  it('etichette CSV', () => {
    expect(posteVerificationLabel({ status: 'delivered', checkCount: 3 })).toBe('Consegnato');
    expect(posteVerificationLabel({ status: 'returned', checkCount: 3 })).toBe('Restituito al mittente');
    expect(posteVerificationLabel({ status: 'pending', checkCount: 12 })).toBe('In verifica (12/90)');
    expect(posteVerificationLabel({ status: 'gave_up', checkCount: 90 })).toBe('Verifica esaurita');
    expect(posteVerificationLabel(null)).toBe('');
  });

  it('ultimo movimento "luogo data" in ora italiana', () => {
    expect(formatLastMovement([
      { at: '2026-08-12T04:19:00.000Z', luogo: 'SVIZZERA', statoLavorazione: 'in data', box: '3', flagRitorno: false },
      { at: '2026-09-04T08:06:00.000Z', luogo: 'SVIZZERA', statoLavorazione: 'con successo in data', box: '5', flagRitorno: false },
    ])).toBe(`SVIZZERA ${new Date('2026-09-04T08:06:00.000Z').toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}`);
    expect(formatLastMovement([])).toBe('');
    expect(formatLastMovement(null)).toBe('');
  });

  it('DTO con date ISO e maxChecks', () => {
    const dto = toPosteVerificationDto({ status: 'pending', trackingCode: 'RN000000000IT', checkCount: 1, nextCheckAt: new Date('2026-09-25T02:00:00Z'), lastCheckedAt: null, lastError: null, deliveredAt: null, outcomeAt: new Date('2026-08-20T09:00:00Z'), movements: null } as any);
    expect(dto).toEqual({ status: 'pending', trackingCode: 'RN000000000IT', checkCount: 1, maxChecks: 90, nextCheckAt: '2026-09-25T02:00:00.000Z', lastCheckedAt: null, lastError: null, deliveredAt: null, outcomeAt: '2026-08-20T09:00:00.000Z', movements: [] });
  });
});
