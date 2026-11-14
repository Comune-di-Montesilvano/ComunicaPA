import { setTimeout as delay } from 'node:timers/promises';
import { Api } from './fixtures/api';
import { API_URL, DEFAULT_MAIL_CONFIG_NAME, MAILPIT_URL } from './fixtures/env';
import { deleteAllMessages } from './fixtures/mailpit';

/** Attende che url risponda 2xx (stack appena avviato o backend appena riavviato). */
async function waitForOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await delay(2_000);
  }
  throw new Error(`${url} non pronto dopo ${timeoutMs / 1000}s (${last})`);
}

/**
 * Idempotente (gira a ogni fase): backend pronto, mail-config EMAIL predefinita e attiva verso
 * Mailpit, casella svuotata.
 */
export default async function globalSetup(): Promise<void> {
  await waitForOk(`${API_URL}/version`, 240_000);
  await waitForOk(`${MAILPIT_URL}/api/v1/info`, 60_000);

  const admin = await Api.login('admin', 'admin');
  let config = (await admin.mailConfigs()).find((c) => c.name === DEFAULT_MAIL_CONFIG_NAME);
  if (!config) {
    config = await admin.post('/admin/mail-configs', {
      type: 'EMAIL',
      name: DEFAULT_MAIL_CONFIG_NAME,
      host: 'mailpit',
      port: 1025,
      secure: false,
      isDefault: true,
      authEnabled: false,
      fromAddress: 'noreply@e2e.test',
      batchSize: 100,
      batchIntervalSeconds: 1,
    });
  }
  // Una config diventa attiva (usabile negli invii) solo dopo un test riuscito.
  if (!config!.active) {
    const res = await admin.post<{ success: boolean; message: string }>(
      `/admin/mail-configs/${config!.id}/test`,
      { to: 'setup@e2e.test' },
    );
    if (!res.success) throw new Error(`Test mail-config predefinita fallito: ${res.message}`);
  }

  await deleteAllMessages();
}
