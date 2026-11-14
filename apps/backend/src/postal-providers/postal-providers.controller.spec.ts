import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PostalProvidersController } from './postal-providers.controller.js';
import { PostalProvidersService } from './postal-providers.service.js';
import { createControllerApp } from '../common/testing/controller-test-app.js';

const ID = '11111111-2222-4333-8444-555555555555';
const NEW = { type: 'GLOBALCOM', name: 'Provider test', baseUrl: 'https://example.invalid', username: 'utente' };

describe('PostalProvidersController (contratto HTTP)', () => {
  let app: INestApplication;
  const svc = { listMasked: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), test: vi.fn(), setActive: vi.fn() };

  beforeAll(async () => {
    app = await createControllerApp(PostalProvidersController, [{ provide: PostalProvidersService, useValue: svc }]);
  });
  afterAll(() => app.close());
  beforeEach(() => vi.resetAllMocks());

  it('GET: 200 con { providers }', async () => {
    svc.listMasked.mockResolvedValue([{ id: ID }]);
    const res = await request(app.getHttpServer()).get('/admin/postal-providers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ providers: [{ id: ID }] });
  });

  it('POST: 201 e DTO inoltrato', async () => {
    svc.create.mockResolvedValue({ id: ID });
    const res = await request(app.getHttpServer()).post('/admin/postal-providers').send(NEW);
    expect(res.status).toBe(201);
    expect(svc.create).toHaveBeenCalledWith(NEW);
  });

  it.each([
    ['type non ammesso', { ...NEW, type: 'ALTRO' }],
    ['name vuoto', { ...NEW, name: '' }],
    ['mittenteProvincia di 3 caratteri', { ...NEW, mittenteProvincia: 'ROM' }],
    ['campo extra', { ...NEW, extra: 1 }],
  ])('POST: %s -> 400', async (_n, body) => {
    await request(app.getHttpServer()).post('/admin/postal-providers').send(body).expect(400);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('PUT :id: 200, id e DTO inoltrati; type non modificabile (400); id non UUID (400)', async () => {
    svc.update.mockResolvedValue({ id: ID });
    const res = await request(app.getHttpServer()).put(`/admin/postal-providers/${ID}`).send({ name: 'Nuovo nome' });
    expect(res.status).toBe(200);
    expect(svc.update).toHaveBeenCalledWith(ID, { name: 'Nuovo nome' });
    await request(app.getHttpServer()).put(`/admin/postal-providers/${ID}`).send({ type: 'GLOBALCOM' }).expect(400);
    await request(app.getHttpServer()).put('/admin/postal-providers/abc').send({ name: 'x' }).expect(400);
    expect(svc.update).toHaveBeenCalledTimes(1);
  });

  it('DELETE :id: 204 senza body; id non UUID -> 400', async () => {
    svc.remove.mockResolvedValue(undefined);
    const res = await request(app.getHttpServer()).delete(`/admin/postal-providers/${ID}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(svc.remove).toHaveBeenCalledWith(ID);
    await request(app.getHttpServer()).delete('/admin/postal-providers/abc').expect(400);
  });

  it('POST :id/test: 200 (non 201)', async () => {
    svc.test.mockResolvedValue({ ok: true });
    const res = await request(app.getHttpServer()).post(`/admin/postal-providers/${ID}/test`);
    expect(res.status).toBe(200);
    expect(svc.test).toHaveBeenCalledWith(ID);
  });

  it('PATCH :id/active: 200 e flag inoltrato; non booleano -> 400', async () => {
    svc.setActive.mockResolvedValue({ id: ID });
    await request(app.getHttpServer()).patch(`/admin/postal-providers/${ID}/active`).send({ active: true }).expect(200);
    expect(svc.setActive).toHaveBeenCalledWith(ID, true);
    await request(app.getHttpServer()).patch(`/admin/postal-providers/${ID}/active`).send({ active: 'true' }).expect(400);
    expect(svc.setActive).toHaveBeenCalledTimes(1);
  });
});
