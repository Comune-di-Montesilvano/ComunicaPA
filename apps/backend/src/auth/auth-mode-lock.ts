import type { Repository } from 'typeorm';
import { AppSetting } from '../entities/app-setting.entity.js';

/**
 * Blocco irreversibile (per istanza) della modalità di autenticazione simulata.
 *
 * `LDAP_HOST=mock` abilita le credenziali di sviluppo (admin/admin,
 * operator/operator, simulatore cittadino). Un'istanza che si è avviata almeno
 * una volta con LDAP reale scrive in `app_settings` la riga
 * `system.authRealSeen` (timestamp ISO del primo avvio reale); da quel momento
 * un avvio con `LDAP_HOST=mock` sullo stesso DB viene rifiutato.
 *
 * La chiave NON sta nel registry delle Impostazioni: `GET admin/settings`
 * itera solo il registry (non la vede) e `PUT admin/settings` rifiuta le
 * chiavi sconosciute — non è leggibile né modificabile da UI/API.
 *
 * Limiti noti:
 * - un'istanza nata in mock e mai avviata con LDAP reale non ha il marker;
 * - cancellare il volume del DB (`docker compose down -v`) azzera il marker;
 * - in dev, dopo un avvio con LDAP reale, per tornare in mock va cancellata a
 *   mano la riga: `DELETE FROM app_settings WHERE key = 'system.authRealSeen';`
 */
export const AUTH_REAL_SEEN_KEY = 'system.authRealSeen';

export class AuthModeLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthModeLockError';
  }
}

type SettingsRepo = Pick<Repository<AppSetting>, 'findOneBy' | 'createQueryBuilder'>;

export async function enforceAuthModeLock(
  ldapHost: string,
  repo: SettingsRepo,
  now: Date = new Date(),
): Promise<'mock' | 'real'> {
  if (ldapHost === 'mock') {
    let marker: AppSetting | null;
    try {
      marker = await repo.findOneBy({ key: AUTH_REAL_SEEN_KEY });
    } catch (err) {
      // Senza poter leggere il marker non si può escludere che l'istanza sia
      // reale: si rifiuta l'avvio.
      throw new AuthModeLockError(
        `LDAP_HOST=mock: impossibile verificare la riga "${AUTH_REAL_SEEN_KEY}" in app_settings ` +
          `(${err instanceof Error ? err.message : String(err)}). Avvio rifiutato.`,
      );
    }
    if (marker) {
      throw new AuthModeLockError(
        `LDAP_HOST=mock rifiutato: questa istanza si è già avviata con LDAP reale ` +
          `(riga "${AUTH_REAL_SEEN_KEY}" in app_settings, valore ${JSON.stringify(marker.value)}). ` +
          `Togliere LDAP_HOST=mock dal .env e configurare l'LDAP reale. ` +
          `Solo in sviluppo locale, per tornare alle credenziali simulate: ` +
          `DELETE FROM app_settings WHERE key = '${AUTH_REAL_SEEN_KEY}';`,
      );
    }
    return 'mock';
  }

  // Idempotente: ON CONFLICT DO NOTHING, il primo timestamp non si sovrascrive.
  await repo
    .createQueryBuilder()
    .insert()
    .into(AppSetting)
    .values({ key: AUTH_REAL_SEEN_KEY, value: now.toISOString(), encrypted: false, updatedBy: 'system' })
    .orIgnore()
    .execute();
  return 'real';
}
