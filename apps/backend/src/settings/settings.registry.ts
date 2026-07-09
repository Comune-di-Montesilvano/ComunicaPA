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
  'send.test.pdndTokenUrl': { type: 'string', default: 'https://auth.uat.interop.pagopa.it/token.oauth2' },
  'send.test.pdndAudience': { type: 'string', default: 'auth.uat.interop.pagopa.it/client-assertion' },
  'send.test.pdndClientId': { type: 'string', default: '' },
  'send.test.pdndKid': { type: 'string', default: '' },
  'send.test.pdndPurposeId': { type: 'string', default: '' },
  'send.test.pdndPrivateKey': { type: 'string', secret: true, default: '' },
  'send.prod.baseUrl': { type: 'string', default: 'https://api.notifichedigitali.it' },
  'send.prod.pdndTokenUrl': { type: 'string', default: 'https://auth.interop.pagopa.it/token.oauth2' },
  'send.prod.pdndAudience': { type: 'string', default: 'auth.interop.pagopa.it/client-assertion' },
  'send.prod.pdndClientId': { type: 'string', default: '' },
  'send.prod.pdndKid': { type: 'string', default: '' },
  'send.prod.pdndPurposeId': { type: 'string', default: '' },
  'send.prod.pdndPrivateKey': { type: 'string', secret: true, default: '' },
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
