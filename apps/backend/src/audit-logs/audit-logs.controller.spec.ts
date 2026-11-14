import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuditLogsController } from './audit-logs.controller.js';
import { AuditLogsService } from './audit-logs.service.js';
import { createControllerApp, TEST_OPERATOR } from '../common/testing/controller-test-app.js';

describe('AuditLogsController (contratto HTTP)', () => {
  const svc = { findAll: vi.fn() };
  let userApp: INestApplication;
  let adminApp: INestApplication;

  beforeAll(async () => {
    const providers = [{ provide: AuditLogsService, useValue: svc }];
    userApp = await createControllerApp(AuditLogsController, providers);
    adminApp = await createControllerApp(AuditLogsController, providers, { username: 'amministratore', role: 'admin', type: 'operator' });
  });
  afterAll(async () => {
    await userApp.close();
    await adminApp.close();
  });
  beforeEach(() => vi.resetAllMocks());

  it('GET: 200, query convertite in numeri e inoltrate; uno user e filtrato sul proprio username', async () => {
    svc.findAll.mockResolvedValue({ items: [], total: 0 });
    const res = await request(userApp.getHttpServer()).get('/admin/audit-logs?page=2&pageSize=50&search=login');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], total: 0 });
    expect(svc.findAll).toHaveBeenCalledWith({ page: 2, pageSize: 50, search: 'login', operatorFilter: TEST_OPERATOR.username });
  });

  it('GET: senza query -> parametri undefined; admin vede tutto (nessun operatorFilter)', async () => {
    svc.findAll.mockResolvedValue({ items: [], total: 0 });
    await request(adminApp.getHttpServer()).get('/admin/audit-logs').expect(200);
    expect(svc.findAll).toHaveBeenCalledWith({ page: undefined, pageSize: undefined, search: undefined, operatorFilter: undefined });
  });

  it.each(['page=abc', 'page=0', 'pageSize=0', 'pageSize=201', 'pageSize=1.5'])(
    'GET: %s -> 400, service non chiamato',
    async (q) => {
      await request(userApp.getHttpServer()).get(`/admin/audit-logs?${q}`).expect(400);
      expect(svc.findAll).not.toHaveBeenCalled();
    },
  );

  it('GET: page e pageSize numerici arrivano al service come numeri', async () => {
    svc.findAll.mockResolvedValue({ items: [], total: 0 });
    await request(userApp.getHttpServer()).get('/admin/audit-logs?page=3&pageSize=200').expect(200);
    expect(svc.findAll.mock.calls[0]![0]).toMatchObject({ page: 3, pageSize: 200 });
  });
});
