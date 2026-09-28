/**
 * Contesto minimo di una richiesta HTTP da allegare a un evento Sentry/
 * GlitchTip, per poter risalire al caso senza inviare dati personali:
 * metodo, rotta come pattern (`/admin/campaigns/:id`, mai l'URL reale con
 * query string), parametri di path solo se non identificativi, e chi ha
 * chiamato (operatore, cittadino, client API esterna).
 *
 * Mai body, query, header: il resto si ricostruisce dal DB partendo dagli ID.
 * Il cittadino compare solo col tipo di accesso — `req.user` contiene CF,
 * email e nome.
 */

// UUID, interi, o token brevi senza cifre né punti (`SEND`, `uat`): un CF ha
// sempre cifre, un nome file ha l'estensione.
const SAFE_PARAM = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{1,10}|[A-Za-z_-]{1,20})$/i;

export interface RequestLike {
  method?: string;
  route?: { path?: unknown };
  params?: Record<string, unknown>;
  user?: Record<string, unknown>;
  apiClient?: { id?: unknown; name?: unknown };
  [key: string]: unknown;
}

type Actor =
  | { type: 'operator'; username: unknown; role: unknown }
  | { type: 'citizen'; accessType: unknown }
  | { type: 'api-client'; id: unknown; name: unknown }
  | { type: 'anonymous' };

export interface RequestContext {
  method: string | undefined;
  route: string | undefined;
  params: Record<string, string>;
  actor: Actor;
}

export function buildRequestContext(req: RequestLike | undefined): RequestContext | undefined {
  if (!req) return undefined;

  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.params ?? {})) {
    params[key] = typeof value === 'string' && SAFE_PARAM.test(value) ? value : '[filtrato]';
  }

  return {
    method: req.method,
    route: typeof req.route?.path === 'string' ? req.route.path : undefined,
    params,
    actor: actorOf(req),
  };
}

function actorOf(req: RequestLike): Actor {
  if (req.apiClient) {
    return { type: 'api-client', id: req.apiClient.id, name: req.apiClient.name };
  }
  const user = req.user;
  if (!user) return { type: 'anonymous' };
  if (user['type'] === 'operator') {
    return { type: 'operator', username: user['username'], role: user['role'] };
  }
  return { type: 'citizen', accessType: user['accessType'] };
}
