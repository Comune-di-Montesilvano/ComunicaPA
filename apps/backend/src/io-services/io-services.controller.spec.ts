import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { IoServicesController } from './io-services.controller.js';
import { IoServicesService } from './io-services.service.js';
import { createControllerApp } from '../common/testing/controller-test-app.js';

const ID = '11111111-2222-4333-8444-555555555555';
const NEW = { nome: 'Servizio test', idService: 'svc-1', apiKeyPrimaria: 'chiave-test' };

describe('IoServicesController (contratto HTTP)', () => {
  let app: INestApplication;
  const svc = { listMasked: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), setDefault: vi.fn(), test: vi.fn(), verifyProfile: vi.fn() };

  beforeAll(async () => {
    app = await createControllerApp(IoServicesController, [{ provide: IoServicesService, useValue: svc }]);
  });
  afterAll(() => app.close());
  beforeEach(() => vi.resetAllMocks());

  it('GET: 200 con { configs }', async () => {
    svc.listMasked.mockResolvedValue([{ id: ID }]);
    const res = await request(app.getHttpServer()).get('/admin/io-services');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configs: [{ id: ID }] });
  });

  it('POST: 201 e DTO inoltrato', async () => {
    svc.create.mockResolvedValue({ id: ID });
    const res = await request(app.getHttpServer()).post('/admin/io-services').send(NEW);
    expect(res.status).toBe(201);
    expect(svc.create).toHaveBeenCalledWith(NEW);
  });

  it.each([
    ['nome vuoto', { ...NEW, nome: '' }],
    ['apiKeyPrimaria mancante', { nome: 'x', idService: 'y' }],
    ['codiceCatalogo oltre 32 caratteri', { ...NEW, codiceCatalogo: 'C'.repeat(33) }],
    ['campo extra', { ...NEW, extra: 1 }],
  ])('POST: %s -> 400', async (_n, body) => {
    await request(app.getHttpServer()).post('/admin/io-services').send(body).expect(400);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('PUT :id: 200 con DTO inoltrato; id non UUID e isDefault (non nel DTO update) -> 400', async () => {
    svc.update.mockResolvedValue({ id: ID });
    await request(app.getHttpServer()).put(`/admin/io-services/${ID}`).send({ nome: 'Nuovo' }).expect(200);
    expect(svc.update).toHaveBeenCalledWith(ID, { nome: 'Nuovo' });
    await request(app.getHttpServer()).put(`/admin/io-services/${ID}`).send({ isDefault: true }).expect(400);
    await request(app.getHttpServer()).put('/admin/io-services/abc').send({ nome: 'x' }).expect(400);
    expect(svc.update).toHaveBeenCalledTimes(1);
  });

  it('DELETE :id: 204 senza body', async () => {
    svc.remove.mockResolvedValue(undefined);
    const res = await request(app.getHttpServer()).delete(`/admin/io-services/${ID}`);
    expect(res.status).toBe(204);
    expect(svc.remove).toHaveBeenCalledWith(ID);
  });

  it('PATCH :id/default: 200 (non 204)', async () => {
    svc.setDefault.mockResolvedValue({ id: ID });
    await request(app.getHttpServer()).patch(`/admin/io-services/${ID}/default`).expect(200);
    expect(svc.setDefault).toHaveBeenCalledWith(ID);
    await request(app.getHttpServer()).patch('/admin/io-services/abc/default').expect(400);
  });

  it('POST :id/test: 200, CF inoltrato; CF mancante -> 400', async () => {
    svc.test.mockResolvedValue({ ok: true });
    await request(app.getHttpServer()).post(`/admin/io-services/${ID}/test`).send({ codiceFiscale: 'RSSMRA80A01H501U' }).expect(200);
    expect(svc.test).toHaveBeenCalledWith(ID, 'RSSMRA80A01H501U');
    await request(app.getHttpServer()).post(`/admin/io-services/${ID}/test`).send({}).expect(400);
    expect(svc.test).toHaveBeenCalledTimes(1);
  });

  it('POST verify-profile: 200 e CF inoltrato', async () => {
    svc.verifyProfile.mockResolvedValue({ enabled: true });
    const res = await request(app.getHttpServer()).post('/admin/io-services/verify-profile').send({ codiceFiscale: 'RSSMRA80A01H501U' });
    expect(res.status).toBe(200);
    expect(svc.verifyProfile).toHaveBeenCalledWith('RSSMRA80A01H501U');
  });

  it('POST verify-profile: body senza CF -> 400, service non chiamato', async () => {
    const res = await request(app.getHttpServer()).post('/admin/io-services/verify-profile').send({});
    expect(res.status).toBe(400);
    expect(svc.verifyProfile).not.toHaveBeenCalled();
  });
});
