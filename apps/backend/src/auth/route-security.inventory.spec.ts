import 'reflect-metadata';
import { countControllerDecorators, listControllers, listRoutes, type RouteInfo } from '../common/testing/controller-routes.js';

/**
 * Inventario autorizzazioni di TUTTE le route HTTP.
 *
 * Le guard sono globali (APP_GUARD JwtAuthGuard + RolesGuard in app.module.ts):
 * una route è protetta solo dai metadata `@Public()`/`@Roles()` e dalle
 * `@UseGuards` proprie. Questo spec legge quei metadata da ogni controller
 * e fallisce se una route diventa pubblica senza essere in allowlist, se una
 * route admin perde i ruoli, o se cambia la tabella (snapshot inline: ogni
 * cambio di autorizzazione compare nel diff della PR).
 */

const key = (r: Pick<RouteInfo, 'method' | 'path'>) => `${r.method} ${r.path}`;

// Route pubbliche SENZA guard propria ammesse. Ogni aggiunta va motivata.
const PUBLIC_ALLOWLIST: (string | RegExp)[] = [
  'GET /', // health (app.controller.ts)
  'GET /version', // app.controller.ts
  'GET /branding', // branding.controller.ts: nome/logo per la pagina di login
  'GET /branding/logo',
  'GET /branding/favicon',
  'POST /admin/auth/login', // login operatore (auth.controller.ts)
  'GET /citizen/auth/config',
  'GET /citizen/auth/oidc/start',
  'POST /citizen/auth/oidc/callback',
  'POST /citizen/auth/login', // login simulatore cittadino (attivo solo con LDAP_HOST=mock)
  /^GET \/public\/download\//, // link firmati (DOWNLOAD_LINK_SECRET) da email/PEC
];

// Controller @Public() che si proteggono da soli con una guard propria: la
// guard deve stare su OGNI loro handler (regola per classe, non per prefisso).
const SELF_GUARDED: Record<string, string> = {
  CitizenController: 'OidcAuthGuard',
  ExternalAttachmentsController: 'ApiKeyGuard',
  ExternalCapabilitiesController: 'ApiKeyGuard',
  ExternalDomicilioController: 'ApiKeyGuard',
  ExternalNotificationsController: 'ApiKeyGuard',
};

// Route admin non pubbliche SENZA @Roles: gap noti, non correzioni di questo
// test (nessun cambio di comportamento).
// Route autenticate senza @Roles ammesse in modo esplicito (oggi nessuna).
const KNOWN_GAPS: string[] = [];

const isAllowlisted = (k: string) => PUBLIC_ALLOWLIST.some((a) => (typeof a === 'string' ? a === k : a.test(k)));

describe('Inventario sicurezza route', () => {
  let routes: RouteInfo[];

  beforeAll(async () => {
    routes = await listRoutes();
  }, 60000);

  it('scansiona tutti i controller', async () => {
    // Guardia contro un falso verde: se la lettura dei metadata fallisce la
    // tabella è vuota e ogni altra asserzione passerebbe.
    const controllers = await listControllers();
    expect(controllers.length).toBe(countControllerDecorators());
    expect(controllers.length).toBeGreaterThan(25);
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.map(key)).toContain('GET /admin/campaigns');
  });

  it('le route pubbliche senza guard sono solo quelle ammesse', () => {
    const unexpected = routes.filter((r) => r.isPublic && r.guards.length === 0 && !isAllowlisted(key(r))).map(key);
    expect(unexpected).toEqual([]);
    // Ogni voce dell'allowlist corrisponde ancora a una route reale.
    const stale = PUBLIC_ALLOWLIST.filter((a) => !routes.some((r) => (typeof a === 'string' ? a === key(r) : a.test(key(r)))));
    expect(stale).toEqual([]);
  });

  it('controller pubblici con guard propria la applicano a ogni handler', () => {
    for (const [controller, guard] of Object.entries(SELF_GUARDED)) {
      const own = routes.filter((r) => r.controller === controller);
      const missing = own.filter((r) => !r.isPublic || !r.guards.includes(guard)).map(key);
      expect({ controller, routes: own.length > 0, missing }).toEqual({ controller, routes: true, missing: [] });
    }
    // Viceversa: nessun altro controller pubblico si affida a una guard propria
    // senza essere censito qui.
    const unlisted = routes.filter((r) => r.isPublic && r.guards.length > 0 && !(r.controller in SELF_GUARDED)).map(key);
    expect(unlisted).toEqual([]);
  });

  it('ogni route admin non pubblica ha ruoli', () => {
    const noRoles = routes
      .filter((r) => r.path.startsWith('/admin/') && !r.isPublic && r.roles.length === 0)
      .map(key);
    expect(noRoles).toEqual(KNOWN_GAPS);
  });

  it('tabella autorizzazioni', () => {
    const table = routes
      .map(
        (r) =>
          `${r.method} ${r.path} | ${r.isPublic ? 'public' : 'auth'} | roles=${r.roles.join(',') || '-'} | guards=${r.guards.join(',') || '-'}`,
      )
      .join('\n');
    expect('\n' + table + '\n').toMatchInlineSnapshot(`
      "
      GET / | public | roles=- | guards=-
      GET /admin/audit-logs | auth | roles=user,admin | guards=-
      POST /admin/auth/login | public | roles=- | guards=-
      GET /admin/auth/me | auth | roles=user,admin | guards=-
      GET /admin/campaigns | auth | roles=user,admin | guards=-
      POST /admin/campaigns | auth | roles=user,admin | guards=-
      DELETE /admin/campaigns/:id | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id | auth | roles=user,admin | guards=-
      PATCH /admin/campaigns/:id | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/attachments | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/attachments/preview-file | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/attachments/progress | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/attachments/upload/chunk/:uploadId/:index | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/attachments/upload/complete/:uploadId | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/attachments/upload/init | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/cancel | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/channel-stats | auth | roles=user,admin | guards=-
      PATCH /admin/campaigns/:id/content | auth | roles=admin | guards=-
      GET /admin/campaigns/:id/cost | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/cost-savings | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/download-combination-stats | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/duplicate-source | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/effective-channel-stats | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/export-download-report.csv | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/export-postal-report-attuale.csv | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/export-postal-report-storico.csv | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/export-send-report-attuale.csv | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/export-send-report-storico.csv | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/failures | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/failures/by-reason | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/inad-check/retry | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/inad-check/skip | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/inad-check/status | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/launch | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/payment-total | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/pending-pec-review | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/postal-delivery-status-breakdown | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/postal-status-breakdown | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/postal/poste-check | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/postal/poste-check | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/postal/reset-errors-for-recheck | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/recipients-by-channel-outcome | auth | roles=user,admin | guards=-
      PATCH /admin/campaigns/:id/recipients/:recipientId/address | auth | roles=user,admin | guards=-
      PATCH /admin/campaigns/:id/recipients/:recipientId/postal/attempts/:attemptNumber/tracking-id | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/recipients/:recipientId/postal/poste-check | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/recipients/:recipientId/postal/refresh-status | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/recipients/:recipientId/resolve-pec-review | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/recipients/:recipientId/retry | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/recipients/draft-csv | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/recipients/draft-csv | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/recipients/retry-bulk | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/recipients/retry-bulk/:jobId | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/recipients/upload | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/recipients/upload/chunk/:uploadId/:index | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/recipients/upload/complete/:uploadId | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/recipients/upload/init | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/remote-sign | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/remote-sign | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/resend-content | auth | roles=admin | guards=-
      GET /admin/campaigns/:id/send-stage-counts | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/send-status-breakdown | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/signature-verification | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/signature-verification | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/signature/unsigned.zip | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/signed-attachments/upload/chunk/:uploadId/:index | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/signed-attachments/upload/complete/:uploadId | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/signed-attachments/upload/init | auth | roles=user,admin | guards=-
      PATCH /admin/campaigns/:id/signer | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/stats | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/stats/recipients | auth | roles=user,admin | guards=-
      GET /admin/campaigns/:id/stats/recipients/filter-options | auth | roles=user,admin | guards=-
      POST /admin/campaigns/:id/test-send | auth | roles=user,admin | guards=-
      POST /admin/campaigns/preview | auth | roles=user,admin | guards=-
      GET /admin/campaigns/recent-activity | auth | roles=user,admin | guards=-
      GET /admin/campaigns/stats/costs | auth | roles=user,admin | guards=-
      GET /admin/campaigns/stats/global | auth | roles=user,admin | guards=-
      GET /admin/campaigns/stats/global/never-downloaded.csv | auth | roles=user,admin | guards=-
      GET /admin/domicile-verification/jobs | auth | roles=user,admin | guards=-
      DELETE /admin/domicile-verification/jobs/:id | auth | roles=user,admin | guards=-
      GET /admin/domicile-verification/jobs/:id | auth | roles=user,admin | guards=-
      GET /admin/domicile-verification/jobs/:id/aggregato.csv | auth | roles=user,admin | guards=-
      GET /admin/domicile-verification/jobs/:id/app-io.csv | auth | roles=user,admin | guards=-
      GET /admin/domicile-verification/jobs/:id/assenti.csv | auth | roles=user,admin | guards=-
      GET /admin/domicile-verification/jobs/:id/inad.csv | auth | roles=user,admin | guards=-
      GET /admin/domicile-verification/jobs/:id/registro-imprese.csv | auth | roles=user,admin | guards=-
      POST /admin/domicile-verification/jobs/:id/skip-inad | auth | roles=admin | guards=-
      POST /admin/domicile-verification/verify/upload/chunk/:uploadId/:index | auth | roles=user,admin | guards=-
      POST /admin/domicile-verification/verify/upload/complete/:uploadId | auth | roles=user,admin | guards=-
      POST /admin/domicile-verification/verify/upload/init | auth | roles=user,admin | guards=-
      POST /admin/domicilio/cerca | auth | roles=user,admin | guards=-
      POST /admin/domicilio/cerca-anagrafica | auth | roles=user,admin | guards=-
      POST /admin/domicilio/cerca-denominazione | auth | roles=user,admin | guards=-
      GET /admin/engines | auth | roles=admin,user | guards=-
      GET /admin/engines/:channel/jobs | auth | roles=admin,user | guards=-
      GET /admin/engines/:channel/jobs/:jobId/logs | auth | roles=admin,user | guards=-
      POST /admin/engines/:channel/pause | auth | roles=admin | guards=-
      POST /admin/engines/:channel/reconcile-orphans | auth | roles=admin | guards=-
      POST /admin/engines/:channel/resume | auth | roles=admin | guards=-
      GET /admin/engines/postal/queue-health | auth | roles=admin,user | guards=-
      GET /admin/engines/poste/queue-health | auth | roles=user,admin | guards=-
      GET /admin/engines/send/stage-counts | auth | roles=admin,user | guards=-
      GET /admin/enrichment/jobs | auth | roles=user,admin | guards=-
      DELETE /admin/enrichment/jobs/:id | auth | roles=admin | guards=-
      GET /admin/enrichment/jobs/:id | auth | roles=user,admin | guards=-
      POST /admin/enrichment/jobs/:id/create-campaign | auth | roles=user,admin | guards=-
      GET /admin/enrichment/jobs/:id/overrides | auth | roles=user,admin | guards=-
      POST /admin/enrichment/jobs/:id/regenerate-csv | auth | roles=user,admin | guards=-
      GET /admin/enrichment/jobs/:id/result.csv | auth | roles=user,admin | guards=-
      GET /admin/enrichment/jobs/:id/result.zip | auth | roles=user,admin | guards=-
      POST /admin/enrichment/jobs/:id/retry-failed-pdfs | auth | roles=user,admin | guards=-
      GET /admin/enrichment/jobs/:id/rows/:pdfFilename | auth | roles=user,admin | guards=-
      PUT /admin/enrichment/jobs/:id/rows/:pdfFilename | auth | roles=user,admin | guards=-
      POST /admin/enrichment/jobs/:id/rows/:pdfFilename/dismiss | auth | roles=user,admin | guards=-
      GET /admin/enrichment/jobs/:id/stream | auth | roles=user,admin | guards=-
      POST /admin/enrichment/upload/batch/:batchId/complete | auth | roles=user,admin | guards=-
      POST /admin/enrichment/upload/batch/init | auth | roles=user,admin | guards=-
      POST /admin/enrichment/upload/chunk/:uploadId/:index | auth | roles=user,admin | guards=-
      POST /admin/enrichment/upload/complete/:uploadId | auth | roles=user,admin | guards=-
      POST /admin/enrichment/upload/init | auth | roles=user,admin | guards=-
      GET /admin/external-clients | auth | roles=admin | guards=-
      POST /admin/external-clients | auth | roles=admin | guards=-
      DELETE /admin/external-clients/:id | auth | roles=admin | guards=-
      POST /admin/external-clients/:id/regenerate-key | auth | roles=admin | guards=-
      POST /admin/inad-verify/verify-single | auth | roles=user,admin | guards=-
      GET /admin/io-services | auth | roles=user,admin | guards=-
      POST /admin/io-services | auth | roles=admin | guards=-
      DELETE /admin/io-services/:id | auth | roles=admin | guards=-
      PUT /admin/io-services/:id | auth | roles=admin | guards=-
      PATCH /admin/io-services/:id/default | auth | roles=admin | guards=-
      POST /admin/io-services/:id/test | auth | roles=admin | guards=-
      POST /admin/io-services/verify-profile | auth | roles=user,admin | guards=-
      GET /admin/legal-attention | auth | roles=user,admin | guards=-
      GET /admin/legal-attention/campaigns/:id | auth | roles=user,admin | guards=-
      POST /admin/legal-attention/reviews | auth | roles=user,admin | guards=-
      GET /admin/mail-configs | auth | roles=user,admin | guards=-
      POST /admin/mail-configs | auth | roles=admin | guards=-
      DELETE /admin/mail-configs/:id | auth | roles=admin | guards=-
      PUT /admin/mail-configs/:id | auth | roles=admin | guards=-
      PATCH /admin/mail-configs/:id/active | auth | roles=admin | guards=-
      PATCH /admin/mail-configs/:id/default | auth | roles=admin | guards=-
      POST /admin/mail-configs/:id/test | auth | roles=admin | guards=-
      GET /admin/notifications-search | auth | roles=user,admin | guards=-
      GET /admin/notifications-search/:recipientId | auth | roles=user,admin | guards=-
      GET /admin/notifications-search/:recipientId/attachment/:index | auth | roles=user,admin | guards=-
      GET /admin/notifications-search/:recipientId/send-legal-facts | auth | roles=user,admin | guards=-
      GET /admin/notifications-search/:recipientId/send-legal-facts/download | auth | roles=user,admin | guards=-
      GET /admin/operators | auth | roles=user,admin | guards=-
      GET /admin/postal-authorized-users | auth | roles=admin | guards=-
      POST /admin/postal-authorized-users | auth | roles=admin | guards=-
      DELETE /admin/postal-authorized-users/:id | auth | roles=admin | guards=-
      GET /admin/postal-providers | auth | roles=user,admin | guards=-
      POST /admin/postal-providers | auth | roles=admin | guards=-
      DELETE /admin/postal-providers/:id | auth | roles=admin | guards=-
      PUT /admin/postal-providers/:id | auth | roles=admin | guards=-
      PATCH /admin/postal-providers/:id/active | auth | roles=admin | guards=-
      POST /admin/postal-providers/:id/test | auth | roles=admin | guards=-
      POST /admin/presence/heartbeat | auth | roles=admin,user | guards=-
      GET /admin/presence/online | auth | roles=admin,user | guards=-
      GET /admin/presence/online-users | auth | roles=admin | guards=-
      GET /admin/remote-sign/config | auth | roles=user,admin | guards=-
      GET /admin/settings | auth | roles=user,admin | guards=-
      PUT /admin/settings | auth | roles=admin | guards=-
      POST /admin/settings/anpr/c002/test-connection | auth | roles=admin | guards=-
      POST /admin/settings/anpr/c019/test-connection | auth | roles=admin | guards=-
      POST /admin/settings/branding/favicon | auth | roles=admin | guards=-
      POST /admin/settings/branding/logo | auth | roles=admin | guards=-
      POST /admin/settings/inad/:env/test-connection | auth | roles=admin | guards=-
      POST /admin/settings/inad/prod/extract | auth | roles=admin | guards=-
      POST /admin/settings/pdnd/:env/generate-keypair | auth | roles=admin | guards=-
      GET /admin/settings/pdnd/:env/private-key | auth | roles=admin | guards=-
      GET /admin/settings/pdnd/:env/public-key | auth | roles=admin | guards=-
      POST /admin/settings/pdnd/:env/validate-client | auth | roles=admin | guards=-
      POST /admin/settings/registro-imprese/:env/test-connection | auth | roles=admin | guards=-
      POST /admin/settings/registro-imprese/prod/dettaglio | auth | roles=admin | guards=-
      POST /admin/settings/remote-sign/test | auth | roles=admin | guards=-
      GET /admin/settings/send/:env/groups | auth | roles=admin | guards=-
      POST /admin/settings/send/:env/test-connection | auth | roles=admin | guards=-
      POST /admin/settings/test-email | auth | roles=admin | guards=-
      POST /admin/settings/test-pec | auth | roles=admin | guards=-
      GET /admin/templates | auth | roles=user,admin | guards=-
      POST /admin/templates | auth | roles=user,admin | guards=-
      DELETE /admin/templates/:id | auth | roles=user,admin | guards=-
      GET /admin/templates/:id | auth | roles=user,admin | guards=-
      PUT /admin/templates/:id | auth | roles=user,admin | guards=-
      GET /branding | public | roles=- | guards=-
      GET /branding/favicon | public | roles=- | guards=-
      GET /branding/logo | public | roles=- | guards=-
      GET /citizen/auth/config | public | roles=- | guards=-
      POST /citizen/auth/login | public | roles=- | guards=-
      POST /citizen/auth/oidc/callback | public | roles=- | guards=-
      GET /citizen/auth/oidc/start | public | roles=- | guards=-
      GET /citizen/notifications | public | roles=- | guards=OidcAuthGuard
      GET /citizen/notifications/:id | public | roles=- | guards=OidcAuthGuard
      GET /citizen/notifications/:id/attachment/:index | public | roles=- | guards=OidcAuthGuard
      POST /citizen/notifications/:id/download | public | roles=- | guards=OidcAuthGuard
      GET /citizen/notifications/:id/send-link | public | roles=- | guards=OidcAuthGuard
      POST /external/v2/attachments/upload/chunk | public | roles=- | guards=ApiKeyGuard
      POST /external/v2/attachments/upload/complete | public | roles=- | guards=ApiKeyGuard
      POST /external/v2/attachments/upload/init | public | roles=- | guards=ApiKeyGuard
      GET /external/v2/capabilities | public | roles=- | guards=ApiKeyGuard
      POST /external/v2/domicilio/cerca | public | roles=- | guards=ApiKeyGuard
      POST /external/v2/notifications | public | roles=- | guards=ApiKeyGuard
      GET /external/v2/notifications/:notificationId | public | roles=- | guards=ApiKeyGuard
      GET /public/download/:recipientId/:index | public | roles=- | guards=-
      GET /version | public | roles=- | guards=-
      "
    `);
  });
});
