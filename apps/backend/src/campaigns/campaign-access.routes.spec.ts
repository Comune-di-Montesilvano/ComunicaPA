import 'reflect-metadata';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ParseUUIDPipe } from '@nestjs/common';
import { CAMPAIGN_ID_ROUTE } from './campaign-access.interceptor.js';

// Chiavi metadata interne di Nest (@nestjs/common/constants e
// RouteParamtypes.PARAM): stabili da anni, ripetute qui per non importare
// path interni del pacchetto.
const PATH_METADATA = 'path';
const ROUTE_ARGS_METADATA = '__routeArguments__';
const ROUTE_PARAM_TYPE = 5;

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

type RouteArg = { index: number; data?: unknown; pipes?: unknown[] };

const joinPath = (...parts: string[]) =>
  '/' + parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
const asPaths = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [v == null ? '' : String(v)]);
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
    const files = (readdirSync(SRC, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.controller.ts'))
      .map((f) => join(SRC, f));

    const checked: string[] = [];
    const violations: string[] = [];
    for (const file of files) {
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      for (const ctrl of Object.values(mod)) {
        if (typeof ctrl !== 'function' || !Reflect.hasMetadata(PATH_METADATA, ctrl)) continue;
        const ctrlPaths = asPaths(Reflect.getMetadata(PATH_METADATA, ctrl));
        const proto = (ctrl as { prototype: object }).prototype;
        for (const method of Object.getOwnPropertyNames(proto)) {
          if (method === 'constructor') continue;
          const handler = (proto as Record<string, unknown>)[method];
          if (typeof handler !== 'function' || !Reflect.hasMetadata(PATH_METADATA, handler)) continue;
          const routes = ctrlPaths.flatMap((cp) => asPaths(Reflect.getMetadata(PATH_METADATA, handler)).map((mp) => joinPath(cp, mp)));
          if (!routes.some((r) => CAMPAIGN_ID_ROUTE.test(r))) continue;
          const name = `${(ctrl as { name: string }).name}.${method} (${routes.join(', ')})`;
          checked.push(name);
          for (const [key, arg] of Object.entries((Reflect.getMetadata(ROUTE_ARGS_METADATA, ctrl, method) ?? {}) as Record<string, RouteArg>)) {
            if (Number(key.split(':')[0]) !== ROUTE_PARAM_TYPE) continue;
            // @Param() senza nome espone anche id, senza pipe per-campo.
            if (arg.data === undefined) violations.push(`${name}: @Param() intero`);
            else if (arg.data === 'id' && !(arg.pipes ?? []).some(isUuidPipe)) violations.push(`${name}: @Param('id') senza ParseUUIDPipe`);
          }
        }
      }
    }

    // Guardia contro un falso verde (scansione vuota per un path sbagliato).
    expect(checked.length).toBeGreaterThan(20);
    expect(violations).toEqual([]);
  }, 60000);
});
