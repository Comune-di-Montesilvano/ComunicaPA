// URL dello stack sotto test, da env (run.sh li imposta sulla rete interna del progetto compose).
// Default = porte host di run.sh, per lanciare Playwright fuori dal container durante il debug.
const trimSlash = (u: string): string => u.replace(/\/+$/, '');

export const ADMIN_URL = trimSlash(process.env['ADMIN_URL'] ?? 'http://localhost:3100');
export const CITIZEN_URL = trimSlash(process.env['CITIZEN_URL'] ?? 'http://localhost:3101');
// Il nginx del frontend proxya /api/ verso il backend strippando il prefisso (come in produzione).
export const API_URL = trimSlash(process.env['API_URL'] ?? `${ADMIN_URL}/api`);
export const MAILPIT_URL = trimSlash(process.env['MAILPIT_URL'] ?? 'http://localhost:18025');

/** Cartella di stato tra fase 1 e fase 2 (stesso container, processi diversi). */
export const STATE_DIR = process.env['E2E_STATE_DIR'] ?? '.e2e-state';

/** Nome fisso della mail-config predefinita creata dal globalSetup. */
export const DEFAULT_MAIL_CONFIG_NAME = 'E2E Mailpit';
