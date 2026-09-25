import { describe, it, expect } from 'vitest';
import { POSTE_DELIVERED_BUCKET, isPosteDeliveredOverride, posteDeliveredSql, posteVerificationLabel, formatLastMovement, toPosteVerificationDto, posteSummaryOf } from './poste-tracking-effective.util.js';

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
    expect(posteVerificationLabel({ status: 'delivered' })).toBe('Consegnato');
    expect(posteVerificationLabel({ status: 'returned' })).toBe('Restituito al mittente');
    expect(posteVerificationLabel({ status: 'pending', trackingUntil: '2026-10-27T18:05:03.000Z' })).toBe(`In verifica fino al ${new Date('2026-10-27T18:05:03.000Z').toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' })}`);
    expect(posteVerificationLabel({ status: 'pending', trackingUntil: null })).toBe('In verifica');
    expect(posteVerificationLabel({ status: 'gave_up', trackingUntil: null })).toBe('Verifica esaurita (90 giorni)');
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

  it('DTO con date ISO, fine finestra e sintesi', () => {
    const dto = toPosteVerificationDto({ status: 'pending', trackingCode: 'RN000000000IT', checkCount: 1, nextCheckAt: new Date('2026-09-25T02:00:00Z'), lastCheckedAt: null, lastError: null, deliveredAt: null, outcomeAt: new Date('2026-08-20T09:00:00Z'), trackingUntil: new Date('2026-10-27T18:05:03Z'), movements: null, lastResponse: { sintesiStato: 'La spedizione è in giacenza' }, posteEsitoRicerca: '3' } as any);
    expect(dto).toEqual({ status: 'pending', trackingCode: 'RN000000000IT', checkCount: 1, trackingUntil: '2026-10-27T18:05:03.000Z', nextCheckAt: '2026-09-25T02:00:00.000Z', lastCheckedAt: null, lastError: null, deliveredAt: null, outcomeAt: '2026-08-20T09:00:00.000Z', summary: 'La spedizione è in giacenza', movements: [] });
  });

  it('sintesi Poste: frase di Poste, altrimenti ultimo movimento, altrimenti "nessuna informazione"', () => {
    expect(posteSummaryOf({ lastResponse: { sintesiStato: 'La spedizione è stata restituita al mittente' }, movements: [], posteEsitoRicerca: '3' } as any)).toBe('La spedizione è stata restituita al mittente');
    const at = '2026-08-12T04:19:00.000Z';
    expect(posteSummaryOf({ lastResponse: { sintesiStato: '' }, movements: [{ at, luogo: 'SVIZZERA', statoLavorazione: 'in data', box: '3', flagRitorno: false }], posteEsitoRicerca: '3' } as any))
      .toBe(`in data · SVIZZERA · ${new Date(at).toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}`);
    expect(posteSummaryOf({ lastResponse: { esitoRicerca: '1' }, movements: [], posteEsitoRicerca: '1' } as any)).toBe('Nessuna informazione su Poste per questo codice');
    expect(posteSummaryOf({ lastResponse: null, movements: null, posteEsitoRicerca: null } as any)).toBeNull();
  });
});
