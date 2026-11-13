import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RequestMethod } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator.js';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator.js';

// Helper solo per i test: scansiona TUTTI i `*.controller.ts` sotto src/ e
// legge i metadata Nest di ogni handler. Usato dagli spec che verificano
// invarianti trasversali sulle route (ParseUUIDPipe su admin/campaigns/:id,
// inventario autorizzazioni).

// Chiavi metadata interne di Nest (@nestjs/common/constants e
// RouteParamtypes.PARAM): stabili da anni, ripetute qui per non importare
// path interni del pacchetto.
export const PATH_METADATA = 'path';
export const METHOD_METADATA = 'method';
export const GUARDS_METADATA = '__guards__';
export const ROUTE_ARGS_METADATA = '__routeArguments__';
export const ROUTE_PARAM_TYPE = 5;

export const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Classe controller o metodo handler: target dei metadata Reflect.
type AnyFn = (...args: never[]) => unknown;

export type RouteInfo = {
  method: string;
  path: string;
  controller: string;
  handler: string;
  isPublic: boolean;
  roles: string[];
  guards: string[];
};

/** Handler di controller con i path completi (una voce per handler, non per path). */
export type ControllerHandler = {
  controller: AnyFn;
  controllerName: string;
  file: string;
  method: string;
  handler: AnyFn;
  paths: string[];
};

export const joinPath = (...parts: string[]): string =>
  '/' + parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
const asPaths = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [v == null ? '' : String(v)]);

/** Path assoluti di tutti i file `*.controller.ts` sotto src/. */
export function listControllerFiles(): string[] {
  return (readdirSync(SRC_DIR, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.controller.ts'))
    .map((f) => join(SRC_DIR, f))
    .sort();
}

/** Numero di occorrenze di `@Controller(` nel sorgente dei file controller (riferimento anti-falso-verde). */
export function countControllerDecorators(): number {
  return listControllerFiles().reduce((n, f) => n + (readFileSync(f, 'utf8').match(/@Controller\(/g) ?? []).length, 0);
}

/** Classi controller (con metadata `path`) esportate dai file controller. */
export async function listControllers(): Promise<{ controller: AnyFn; file: string }[]> {
  const out: { controller: AnyFn; file: string }[] = [];
  for (const file of listControllerFiles()) {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    for (const ctrl of Object.values(mod)) {
      if (typeof ctrl !== 'function' || !Reflect.hasMetadata(PATH_METADATA, ctrl)) continue;
      out.push({ controller: ctrl as AnyFn, file });
    }
  }
  return out;
}

export async function listHandlers(): Promise<ControllerHandler[]> {
  const out: ControllerHandler[] = [];
  for (const { controller, file } of await listControllers()) {
    const ctrlPaths = asPaths(Reflect.getMetadata(PATH_METADATA, controller));
    const proto = (controller as { prototype: object }).prototype;
    for (const method of Object.getOwnPropertyNames(proto)) {
      if (method === 'constructor') continue;
      const handler = (proto as Record<string, unknown>)[method];
      if (typeof handler !== 'function' || !Reflect.hasMetadata(PATH_METADATA, handler)) continue;
      const paths = ctrlPaths.flatMap((cp) => asPaths(Reflect.getMetadata(PATH_METADATA, handler)).map((mp) => joinPath(cp, mp)));
      out.push({ controller, controllerName: controller.name, file, method, handler: handler as AnyFn, paths });
    }
  }
  return out;
}

const guardName = (g: unknown): string =>
  typeof g === 'function' ? g.name : (g as { constructor?: { name?: string } })?.constructor?.name ?? String(g);

/**
 * Una voce per (handler, path). `isPublic`/`roles` replicano
 * `Reflector.getAllAndOverride` usato dalle guard globali (handler vince su
 * classe); `guards` sono le guard `@UseGuards` di classe + handler.
 */
export async function listRoutes(): Promise<RouteInfo[]> {
  const routes: RouteInfo[] = [];
  for (const h of await listHandlers()) {
    const override = <T>(key: string): T | undefined =>
      (Reflect.getMetadata(key, h.handler) as T | undefined) ?? (Reflect.getMetadata(key, h.controller) as T | undefined);
    const methodNum = Reflect.getMetadata(METHOD_METADATA, h.handler) as number;
    const guards = [
      ...((Reflect.getMetadata(GUARDS_METADATA, h.controller) as unknown[] | undefined) ?? []),
      ...((Reflect.getMetadata(GUARDS_METADATA, h.handler) as unknown[] | undefined) ?? []),
    ].map(guardName);
    for (const path of h.paths) {
      routes.push({
        method: RequestMethod[methodNum] ?? String(methodNum),
        path,
        controller: h.controllerName,
        handler: h.method,
        isPublic: override<boolean>(IS_PUBLIC_KEY) === true,
        roles: [...(override<string[]>(ROLES_KEY) ?? [])],
        guards,
      });
    }
  }
  // Confronto per code unit (non localeCompare): ordine identico su ogni locale/ICU.
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return routes.sort((a, b) => cmp(a.path, b.path) || cmp(a.method, b.method));
}
