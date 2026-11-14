import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { Api, runSuffix } from '../fixtures/api';
import { STATE_DIR } from '../fixtures/env';
import { searchMessages } from '../fixtures/mailpit';
import { innermostCard, loginAdmin, sidebarLink } from '../fixtures/ui';

// Flusso 3: un secret salvato da UI (password SMTP, cifrata in DB con chiave derivata da
// JWT_SECRET) non torna mai in chiaro e sopravvive al riavvio del backend.
//   @phase1: salva la mail-config con password -> la UI mostra solo il valore mascherato.
//   (run.sh: `docker compose ... restart backend`)
//   @phase2: "Invia Test" riuscito -> la password e' stata decifrata dal processo nuovo.
const MASKED_VALUE = '••••••••';
const STATE_FILE = join(STATE_DIR, 'settings-secret.json');

interface State {
  suffix: string;
  configName: string;
}

async function openEmailServers(page: Page): Promise<void> {
  await loginAdmin(page, 'admin', 'admin');
  await sidebarLink(page, 'Impostazioni').click();
  await page.getByRole('button', { name: 'E-Mail Server', exact: true }).click();
  await expect(page.getByText(/Server E-Mail Configurati/i)).toBeVisible();
}

test('@phase1 mail-config con password: la UI mostra solo il valore mascherato', async ({ page }) => {
  const suffix = runSuffix();
  const configName = `E2E secret ${suffix}`;
  const password = `pw-${randomBytes(12).toString('hex')}`;

  await openEmailServers(page);
  await page.getByRole('button', { name: 'Nuovo Server E-Mail' }).click();
  const form = page.locator('form').filter({ has: page.getByPlaceholder('smtp.ente.it') });
  await form.getByPlaceholder('Es. SMTP Istituzionale').fill(configName);
  await form.getByPlaceholder('noreply@ente.it').fill(`secret.${suffix}@e2e.test`);
  await form.getByPlaceholder('smtp.ente.it').fill('mailpit');
  // Primo campo numerico del form = Porta (le label non sono associate agli input)
  await form.getByRole('spinbutton').first().fill('1025');
  await form.getByPlaceholder('Username (se richiesto)').fill(`user-${suffix}`);
  await form.getByPlaceholder('Password (se richiesta)').fill(password);
  await expect(form.getByLabel('Abilita Autenticazione')).toBeChecked();
  await form.getByRole('button', { name: 'Salva', exact: true }).click();
  await expect(page.getByText('Configurazione salvata con successo!')).toBeVisible();

  // Riaprendo la config il campo password contiene solo il segnaposto mascherato
  const card = innermostCard(page, configName);
  await card.getByRole('button', { name: 'Modifica' }).click();
  await expect(form.locator('input[type="password"]')).toHaveValue(MASKED_VALUE);
  expect(await page.content()).not.toContain(password);
  await form.getByRole('button', { name: 'Annulla' }).click();

  // Stesso vincolo sull'API (lista mascherata)
  const api = await Api.login('admin', 'admin');
  const saved = (await api.mailConfigs()).find((c) => c.name === configName);
  expect(saved?.password).toBe(MASKED_VALUE);

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ suffix, configName } satisfies State));
});

test('@phase2 dopo il restart del backend il test connessione con password riesce', async ({ page }) => {
  // Presuppone che run.sh abbia riavviato il backend (`docker compose ... restart backend`) dopo la fase 1.
  const { suffix, configName } = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;

  await openEmailServers(page);
  const card = innermostCard(page, configName);
  await card.getByPlaceholder('destinatario@test.it').fill(`verify.${suffix}@e2e.test`);
  await card.getByRole('button', { name: 'Invia Test' }).click();
  await expect(page.getByText('Messaggio di test inviato con successo!')).toBeVisible();

  // L'oggetto del messaggio di test contiene il nome della config (quindi il suffisso)
  await expect.poll(async () => (await searchMessages(suffix)).length, { timeout: 30_000 }).toBe(1);
  const [message] = await searchMessages(suffix);
  expect(message!.To[0]?.Address).toBe(`verify.${suffix}@e2e.test`);
});
