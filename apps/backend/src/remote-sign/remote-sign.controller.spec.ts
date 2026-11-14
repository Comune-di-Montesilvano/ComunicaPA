import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { RemoteSignController } from './remote-sign.controller.js';
import { RemoteSignService } from './remote-sign.service.js';
import { createControllerApp, TEST_OPERATOR } from '../common/testing/controller-test-app.js';

const ID = '11111111-2222-4333-8444-555555555555';
const CREDS = { user: 'firmatario', password: 'segreto-test', otp: '123456' };

describe('RemoteSignController (contratto HTTP)', () => {
  let app: INestApplication;
  const svc = {
    isEnabled: vi.fn(), getOtpDomain: vi.fn(), start: vi.fn(), assertCanRead: vi.fn(), getLatestStatus: vi.fn(), testSign: vi.fn(),
  };

  beforeAll(async () => {
    app = await createControllerApp(RemoteSignController, [{ provide: RemoteSignService, useValue: svc }]);
  });
  afterAll(() => app.close());
  beforeEach(() => vi.resetAllMocks());

  it('GET remote-sign/config: 200 con enabled e otpDomain', async () => {
    svc.isEnabled.mockResolvedValue(true);
    svc.getOtpDomain.mockResolvedValue('dominio');
    const res = await request(app.getHttpServer()).get('/admin/remote-sign/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, otpDomain: 'dominio' });
  });

  it('POST campaigns/:id/remote-sign: 200 (non 201), utente e DTO inoltrati', async () => {
    svc.start.mockResolvedValue({ jobId: 'j1' });
    const res = await request(app.getHttpServer()).post(`/admin/campaigns/${ID}/remote-sign`).send(CREDS);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jobId: 'j1' });
    expect(svc.start).toHaveBeenCalledWith(ID, { username: TEST_OPERATOR.username, role: TEST_OPERATOR.role }, CREDS);
  });

  it.each([
    ['OTP di 5 cifre', { ...CREDS, otp: '12345' }],
    ['OTP non numerico', { ...CREDS, otp: 'abcdef' }],
    ['password vuota', { ...CREDS, password: '' }],
    ['user mancante', { password: 'x', otp: '123456' }],
    ['campo extra', { ...CREDS, extra: 1 }],
  ])('POST campaigns/:id/remote-sign: %s -> 400', async (_n, body) => {
    await request(app.getHttpServer()).post(`/admin/campaigns/${ID}/remote-sign`).send(body).expect(400);
    expect(svc.start).not.toHaveBeenCalled();
  });

  it('POST campaigns/:id/remote-sign: id non UUID -> 400', async () => {
    await request(app.getHttpServer()).post('/admin/campaigns/non-uuid/remote-sign').send(CREDS).expect(400);
    expect(svc.start).not.toHaveBeenCalled();
  });

  it('GET campaigns/:id/remote-sign: 200 con job; senza job 200 e body vuoto (non 404)', async () => {
    svc.assertCanRead.mockResolvedValue(undefined);
    svc.getLatestStatus.mockResolvedValueOnce({ status: 'RUNNING' });
    const ok = await request(app.getHttpServer()).get(`/admin/campaigns/${ID}/remote-sign`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ status: 'RUNNING' });
    expect(svc.assertCanRead).toHaveBeenCalledWith(ID, { username: TEST_OPERATOR.username, role: TEST_OPERATOR.role });

    svc.getLatestStatus.mockResolvedValueOnce(undefined);
    const vuoto = await request(app.getHttpServer()).get(`/admin/campaigns/${ID}/remote-sign`);
    expect(vuoto.status).toBe(200);
    expect(vuoto.text).toBe('');
  });

  it('GET campaigns/:id/remote-sign: id non UUID -> 400', async () => {
    await request(app.getHttpServer()).get('/admin/campaigns/xyz/remote-sign').expect(400);
  });

  it('POST settings/remote-sign/test: 200 e credenziali inoltrate; DTO invalido -> 400', async () => {
    svc.testSign.mockResolvedValue({ ok: true });
    const res = await request(app.getHttpServer()).post('/admin/settings/remote-sign/test').send(CREDS);
    expect(res.status).toBe(200);
    expect(svc.testSign).toHaveBeenCalledWith(CREDS);
    await request(app.getHttpServer()).post('/admin/settings/remote-sign/test').send({ ...CREDS, otp: '1' }).expect(400);
    expect(svc.testSign).toHaveBeenCalledTimes(1);
  });
});
