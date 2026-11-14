import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DomicilioController } from './domicilio.controller.js';
import { DomicilioService } from './domicilio.service.js';
import { AuditLogsService } from '../../audit-logs/audit-logs.service.js';
import { createControllerApp, TEST_OPERATOR } from '../../common/testing/controller-test-app.js';

describe('DomicilioController (contratto HTTP)', () => {
  let app: INestApplication;
  const svc = { cercaDomicilio: vi.fn(), cercaPerAnagrafica: vi.fn(), cercaPerDenominazione: vi.fn() };
  const audit = { log: vi.fn() };

  beforeAll(async () => {
    app = await createControllerApp(DomicilioController, [
      { provide: DomicilioService, useValue: svc },
      { provide: AuditLogsService, useValue: audit },
    ]);
  });
  afterAll(() => app.close());
  beforeEach(() => vi.resetAllMocks());

  it('POST cerca: 200, CF normalizzato al service, audit scritto', async () => {
    svc.cercaDomicilio.mockResolvedValue({ found: true });
    const res = await request(app.getHttpServer()).post('/admin/domicilio/cerca').send({ codiceFiscale: ' rssmra80a01h501u ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ found: true });
    expect(svc.cercaDomicilio).toHaveBeenCalledWith('RSSMRA80A01H501U', TEST_OPERATOR.username, false);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DOMICILIO_SEARCH', operator: TEST_OPERATOR.username }));
  });

  it('POST cerca: forzaImpresa true inoltrato', async () => {
    svc.cercaDomicilio.mockResolvedValue({});
    await request(app.getHttpServer()).post('/admin/domicilio/cerca').send({ codiceFiscale: 'RSSMRA80A01H501U', forzaImpresa: true }).expect(200);
    expect(svc.cercaDomicilio).toHaveBeenCalledWith('RSSMRA80A01H501U', TEST_OPERATOR.username, true);
  });

  it.each([
    ['CF vuoto', { codiceFiscale: '' }],
    ['CF mancante', {}],
    ['forzaImpresa non booleano', { codiceFiscale: 'X', forzaImpresa: 'si' }],
    ['campo extra', { codiceFiscale: 'X', altro: 1 }],
  ])('POST cerca: %s -> 400 senza chiamare il service', async (_n, body) => {
    await request(app.getHttpServer()).post('/admin/domicilio/cerca').send(body).expect(400);
    expect(svc.cercaDomicilio).not.toHaveBeenCalled();
  });

  const anagrafica = {
    cognome: 'ROSSI', nome: 'MARIO', sesso: 'M', dataNascita: '1980-01-01', comuneNascita: 'ROMA', motivoRichiesta: 'pratica 1',
  };

  it('POST cerca-anagrafica: 200, criteri e motivo inoltrati, audit con CF trovato', async () => {
    svc.cercaPerAnagrafica.mockResolvedValue({ found: true, generalita: { codiceFiscale: { codFiscale: 'RSSMRA80A01H501U' } } });
    const res = await request(app.getHttpServer()).post('/admin/domicilio/cerca-anagrafica').send(anagrafica);
    expect(res.status).toBe(200);
    const [criteri, operator, motivo] = svc.cercaPerAnagrafica.mock.calls[0]!;
    expect(criteri).toMatchObject({ cognome: 'ROSSI', nome: 'MARIO', sesso: 'M', comuneNascita: 'ROMA' });
    expect(operator).toBe(TEST_OPERATOR.username);
    expect(motivo).toBe('pratica 1');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DOMICILIO_SEARCH_ANAGRAFICA', details: expect.objectContaining({ codiceFiscaleTrovato: 'RSSMRA80A01H501U' }) }),
    );
  });

  it('POST cerca-anagrafica: motivoRichiesta mancante -> 400', async () => {
    const { motivoRichiesta: _m, ...senzaMotivo } = anagrafica;
    await request(app.getHttpServer()).post('/admin/domicilio/cerca-anagrafica').send(senzaMotivo).expect(400);
    expect(svc.cercaPerAnagrafica).not.toHaveBeenCalled();
  });

  it('POST cerca-denominazione: 200 e parametri inoltrati', async () => {
    svc.cercaPerDenominazione.mockResolvedValue({ posizioni: [{}, {}] });
    const res = await request(app.getHttpServer()).post('/admin/domicilio/cerca-denominazione').send({ denominazione: 'ACME SRL', siglaProvincia: 'RM' });
    expect(res.status).toBe(200);
    expect(svc.cercaPerDenominazione).toHaveBeenCalledWith('ACME SRL', 'RM');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'DOMICILIO_SEARCH_DENOMINAZIONE', details: expect.objectContaining({ found: 2 }) }));
  });

  it.each([
    ['denominazione di 1 carattere', { denominazione: 'A' }],
    ['denominazione oltre 50 caratteri', { denominazione: 'A'.repeat(51) }],
    ['sigla provincia di 3 caratteri', { denominazione: 'ACME', siglaProvincia: 'ROM' }],
  ])('POST cerca-denominazione: %s -> 400', async (_n, body) => {
    await request(app.getHttpServer()).post('/admin/domicilio/cerca-denominazione').send(body).expect(400);
    expect(svc.cercaPerDenominazione).not.toHaveBeenCalled();
  });
});
