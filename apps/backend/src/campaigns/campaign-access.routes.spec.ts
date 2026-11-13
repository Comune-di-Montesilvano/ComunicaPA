import 'reflect-metadata';
import { ParseUUIDPipe } from '@nestjs/common';
import { CAMPAIGN_ID_ROUTE } from './campaign-access.interceptor.js';
import { listHandlers, ROUTE_ARGS_METADATA, ROUTE_PARAM_TYPE } from '../common/testing/controller-routes.js';

type RouteArg = { index: number; data?: unknown; pipes?: unknown[] };

const isUuidPipe = (p: unknown) => p === ParseUUIDPipe || p instanceof ParseUUIDPipe;

/**
 * Invariante di CampaignAccessInterceptor: l'interceptor salta gli id non in
 * forma UUID canonica (con trattini), lasciandoli a ParseUUIDPipe. Postgres
 * però accetta anche UUID senza trattini: un handler `admin/campaigns/:id`
 * che legge `id` senza ParseUUIDPipe aggirerebbe il controllo di visibilità.
 * Questo test scorre TUTTI i controller e fallisce se un handler del genere
 * compare.
 */
describe('CampaignAccessInterceptor — invariante ParseUUIDPipe su admin/campaigns/:id', () => {
  it('ogni handler admin/campaigns/:id che legge il param id usa ParseUUIDPipe', async () => {
    const checked: string[] = [];
    const violations: string[] = [];
    for (const h of await listHandlers()) {
      if (!h.paths.some((r) => CAMPAIGN_ID_ROUTE.test(r))) continue;
      const name = `${h.controllerName}.${h.method} (${h.paths.join(', ')})`;
      checked.push(name);
      for (const [key, arg] of Object.entries((Reflect.getMetadata(ROUTE_ARGS_METADATA, h.controller, h.method) ?? {}) as Record<string, RouteArg>)) {
        if (Number(key.split(':')[0]) !== ROUTE_PARAM_TYPE) continue;
        // @Param() senza nome espone anche id, senza pipe per-campo.
        if (arg.data === undefined) violations.push(`${name}: @Param() intero`);
        else if (arg.data === 'id' && !(arg.pipes ?? []).some(isUuidPipe)) violations.push(`${name}: @Param('id') senza ParseUUIDPipe`);
      }
    }

    // Guardia contro un falso verde (scansione vuota per un path sbagliato).
    expect(checked.length).toBeGreaterThan(20);
    expect(violations).toEqual([]);
  }, 60000);
});
