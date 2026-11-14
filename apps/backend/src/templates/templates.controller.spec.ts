import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TemplatesController } from './templates.controller.js';
import { TemplatesService } from './templates.service.js';
import { createControllerApp } from '../common/testing/controller-test-app.js';

const ID = '11111111-2222-4333-8444-555555555555';
const MAIL = { type: 'MAIL', name: 'Avviso', subject: 'Oggetto', bodyHtml: '<p>Ciao</p>' };
const APP_IO = { type: 'APP_IO', name: 'Avviso IO', subject: 'Oggetto', bodyMarkdown: 'Ciao' };

describe('TemplatesController (contratto HTTP)', () => {
  let app: INestApplication;
  const svc = { list: vi.fn(), findOne: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() };

  beforeAll(async () => {
    app = await createControllerApp(TemplatesController, [{ provide: TemplatesService, useValue: svc }]);
  });
  afterAll(() => app.close());
  beforeEach(() => vi.resetAllMocks());

  it('GET: 200 con { templates }', async () => {
    svc.list.mockResolvedValue([{ id: ID }]);
    const res = await request(app.getHttpServer()).get('/admin/templates');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ templates: [{ id: ID }] });
  });

  it('GET :id: 200 con id inoltrato; id non UUID -> 400', async () => {
    svc.findOne.mockResolvedValue({ id: ID });
    const res = await request(app.getHttpServer()).get(`/admin/templates/${ID}`);
    expect(res.status).toBe(200);
    expect(svc.findOne).toHaveBeenCalledWith(ID);
    await request(app.getHttpServer()).get('/admin/templates/abc').expect(400);
  });

  it.each([['MAIL', MAIL], ['APP_IO', APP_IO]])('POST %s: 201 e DTO inoltrato', async (_n, body) => {
    svc.create.mockResolvedValue({ id: ID });
    const res = await request(app.getHttpServer()).post('/admin/templates').send(body);
    expect(res.status).toBe(201);
    expect(svc.create).toHaveBeenCalledWith(body);
  });

  it.each([
    ['type non ammesso', { ...MAIL, type: 'SMS' }],
    ['MAIL senza bodyHtml', { type: 'MAIL', name: 'x', subject: 's' }],
    ['APP_IO senza bodyMarkdown', { type: 'APP_IO', name: 'x', subject: 's' }],
    ['name oltre 128 caratteri', { ...MAIL, name: 'n'.repeat(129) }],
    ['pairedTemplateId non UUID', { ...MAIL, pairedTemplateId: 'abc' }],
    ['campo extra', { ...MAIL, extra: 1 }],
  ])('POST: %s -> 400', async (_n, body) => {
    await request(app.getHttpServer()).post('/admin/templates').send(body).expect(400);
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('PUT :id: 200, id e DTO inoltrati; type non modificabile e id non UUID -> 400', async () => {
    svc.update.mockResolvedValue({ id: ID });
    await request(app.getHttpServer()).put(`/admin/templates/${ID}`).send({ name: 'Nuovo' }).expect(200);
    expect(svc.update).toHaveBeenCalledWith(ID, { name: 'Nuovo' });
    await request(app.getHttpServer()).put(`/admin/templates/${ID}`).send({ type: 'MAIL' }).expect(400);
    await request(app.getHttpServer()).put('/admin/templates/abc').send({ name: 'x' }).expect(400);
    expect(svc.update).toHaveBeenCalledTimes(1);
  });

  it('DELETE :id: 204 senza body; id non UUID -> 400', async () => {
    svc.remove.mockResolvedValue(undefined);
    const res = await request(app.getHttpServer()).delete(`/admin/templates/${ID}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(svc.remove).toHaveBeenCalledWith(ID);
    await request(app.getHttpServer()).delete('/admin/templates/abc').expect(400);
  });
});
