export type SettingValue = string | number | boolean;
export type SettingType = 'string' | 'number' | 'boolean';

export interface SettingDef {
  /** Variabile d'ambiente di fallback (installazioni pre-migrazione). */
  env?: string;
  type: SettingType;
  /** true = cifrato in DB e mascherato nelle risposte admin. */
  secret?: boolean;
  /** true = solo bootstrap: risolto da env/default, mai letto/scritto in DB né modificabile da UI. */
  bootstrapOnly?: boolean;
  default: SettingValue;
}

export const MASKED_VALUE = '••••••••';

export const SETTING_DEFS = {
  'brand.name': { env: 'BRAND_NAME', type: 'string', default: 'Comune di Montesilvano' },
  'brand.subtitle': { type: 'string', default: '' },
  'brand.logo': { env: 'BRAND_LOGO', type: 'string', default: '' },
  'brand.favicon': { type: 'string', default: '' },
  'retention.maxDays': { env: 'RETENTION_MAX_DAYS', type: 'number', default: 90 },
  'smtp.host': { env: 'SMTP_HOST', type: 'string', default: 'localhost' },
  'smtp.port': { env: 'SMTP_PORT', type: 'number', default: 587 },
  'smtp.secure': { env: 'SMTP_SECURE', type: 'boolean', default: false },
  'smtp.user': { env: 'SMTP_USER', type: 'string', default: '' },
  'smtp.password': { env: 'SMTP_PASSWORD', type: 'string', secret: true, default: '' },
  'smtp.from': { env: 'SMTP_FROM', type: 'string', default: 'noreply@comunicapa.local' },
  'pec.host': { env: 'PEC_HOST', type: 'string', default: 'localhost' },
  'pec.port': { env: 'PEC_PORT', type: 'number', default: 587 },
  'pec.secure': { env: 'PEC_SECURE', type: 'boolean', default: false },
  'pec.user': { env: 'PEC_USER', type: 'string', default: '' },
  'pec.password': { env: 'PEC_PASSWORD', type: 'string', secret: true, default: '' },
  'pec.from': { env: 'PEC_FROM', type: 'string', default: 'noreply@pec.comunicapa.local' },
  'send.environment': { env: 'SEND_ENVIRONMENT', type: 'string', default: 'collaudo' },
  'send.test.baseUrl': { type: 'string', default: 'https://api.uat.notifichedigitali.it' },
  // Autenticazione reale verso PN (api.notifichedigitali.it): OGNI chiamata
  // richiede ENTRAMBI gli header x-api-key (portale self-care PN) e
  // Authorization: Bearer <voucher PDND> — confermato dalla documentazione
  // ufficiale developer.pagopa.it (esempio curl verbatim). Lo spec OpenAPI
  // backend da solo documenta solo x-api-key perché non descrive il layer
  // di gateway PDND davanti al backend. purposeId (sotto) resta necessario:
  // usato per ottenere il voucher PDND via PdndAuthService.
  'send.test.apiKey': { type: 'string', secret: true, default: '' },
  'send.test.purposeId': { type: 'string', default: '' },
  // Alcuni account PN sono associati a più "cx_groups" (gruppi utenti ente
  // configurati sul portale self-care PN): in quel caso PN rifiuta la
  // richiesta di invio senza un group esplicito (errore reale riscontrato:
  // "Specify a group in cx_groups=[...]"). Facoltativo — se l'account ha un
  // solo gruppo, PN non lo richiede e questo campo può restare vuoto.
  'send.test.group': { type: 'string', default: '' },
  'send.prod.baseUrl': { type: 'string', default: 'https://api.notifichedigitali.it' },
  'send.prod.apiKey': { type: 'string', secret: true, default: '' },
  'send.prod.purposeId': { type: 'string', default: '' },
  'send.prod.group': { type: 'string', default: '' },
  'send.senderTaxId': { type: 'string', default: '' },
  'send.entityType': { type: 'string', default: '' },
  'send.enabledTaxonomyCodes': { type: 'string', default: '[]' },

  'pdnd.test.tokenUrl': { type: 'string', default: 'https://auth.uat.interop.pagopa.it/token.oauth2' },
  'pdnd.test.audience': { type: 'string', default: 'auth.uat.interop.pagopa.it/client-assertion' },
  'pdnd.test.clientId': { type: 'string', default: '' },
  'pdnd.test.kid': { type: 'string', default: '' },
  'pdnd.test.privateKey': { type: 'string', secret: true, default: '' },
  'pdnd.prod.tokenUrl': { type: 'string', default: 'https://auth.interop.pagopa.it/token.oauth2' },
  'pdnd.prod.audience': { type: 'string', default: 'auth.interop.pagopa.it/client-assertion' },
  'pdnd.prod.clientId': { type: 'string', default: '' },
  'pdnd.prod.kid': { type: 'string', default: '' },
  'pdnd.prod.privateKey': { type: 'string', secret: true, default: '' },

  // INAD/INIPEC: scaffolding in attesa di approvazione PDND e specifiche di
  // integrazione. Solo purposeId per ora (client PDND condiviso via pdnd.*).
  // Se in futuro serve un baseUrl API dedicato, aggiungere qui
  // 'inad.{test,prod}.baseUrl' / 'inipec.{test,prod}.baseUrl' — non anticipato
  // ora perché endpoint non ancora noti.
  'inad.test.purposeId': { type: 'string', default: '' },
  'inad.prod.purposeId': { type: 'string', default: '' },
  'inipec.test.purposeId': { type: 'string', default: '' },
  'inipec.prod.purposeId': { type: 'string', default: '' },

  'protocollo.provider': { type: 'string', default: 'tinn' },
  'protocollo.baseUrl': { type: 'string', default: '' },
  'protocollo.codiceEnte': { type: 'string', default: '' },
  'protocollo.username': { type: 'string', default: '' },
  'protocollo.password': { type: 'string', secret: true, default: '' },
  'protocollo.codiceTitolario': { type: 'string', default: '6022' },
  'protocollo.codiceAmministrazione': { type: 'string', default: '1' },
  'protocollo.unitaOrganizzativa': { type: 'string', default: '1' },
  'protocollo.mittenteDenominazione': { type: 'string', default: '' },
  'system.publicUrl': {
    env: 'PUBLIC_BACKEND_URL',
    type: 'string',
    bootstrapOnly: true,
    default: 'http://localhost:8080',
  },
  'system.citizenPublicUrl': {
    env: 'CITIZEN_ORIGIN',
    type: 'string',
    bootstrapOnly: true,
    default: '',
  },
  'oidc.issuer': { env: 'OIDC_ISSUER', type: 'string', default: '' },
  'oidc.audience': { env: 'OIDC_AUDIENCE', type: 'string', default: '' },
  'oidc.jwksUri': { env: 'OIDC_JWKS_URI', type: 'string', default: '' },
  'oidc.clientId': { env: 'OIDC_CLIENT_ID', type: 'string', default: '' },
  'oidc.clientSecret': { env: 'OIDC_CLIENT_SECRET', type: 'string', secret: true, default: '' },
  'oidc.logoutUrl': { env: 'OIDC_LOGOUT_URL', type: 'string', default: '' },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTING_DEFS;

export function isSettingKey(k: string): k is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_DEFS, k);
}
