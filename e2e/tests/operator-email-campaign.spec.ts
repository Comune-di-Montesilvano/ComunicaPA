import { expect, test } from '@playwright/test';
import { Api, runSuffix } from '../fixtures/api';
import { DEFAULT_MAIL_CONFIG_NAME } from '../fixtures/env';
import { searchMessages } from '../fixtures/mailpit';
import { loginAdmin, sidebarLink } from '../fixtures/ui';

// Flusso 1: operatore (ruolo `user`) crea e lancia dal wizard una campagna Email con un CSV
// di 3 righe fittizie; la campagna arriva a "completed" e Mailpit riceve 3 messaggi con i
// segnaposto risolti.
test('operatore: campagna Email dal wizard fino alla consegna in Mailpit', async ({ page }) => {
  const suffix = runSuffix();
  const campaignName = `E2E Email ${suffix}`;
  const rows = [
    { cf: 'RSSMRA80A01H501U', name: 'ROSSI MARIO', email: `rossi.${suffix}@e2e.test` },
    { cf: 'RSSMRA80A01H501U', name: 'ROSSI MARIA', email: `rossia.${suffix}@e2e.test` },
    { cf: '12345678903', name: 'ACME SRL', email: `acme.${suffix}@e2e.test` },
  ];
  const csv = ['codice_fiscale,full_name,email', ...rows.map((r) => `${r.cf},${r.name},${r.email}`)].join('\n');

  await loginAdmin(page, 'operator', 'operator');
  await sidebarLink(page, 'Invio Massivo').click();

  // Passo 1: dettagli e canale
  await page.getByPlaceholder('Es: Avviso TARI 2026').fill(campaignName);
  await expect(page.locator('select').first()).toHaveValue('EMAIL');
  const sender = page.getByPlaceholder('-- Seleziona Configurazione Mittente --');
  await sender.click();
  await sender.fill(DEFAULT_MAIL_CONFIG_NAME);
  await sender.press('Enter');
  await expect(sender).toHaveValue(new RegExp(`^${DEFAULT_MAIL_CONFIG_NAME}`));
  // Niente co-consegna App IO (nessun servizio IO configurato nello stack E2E)
  await page.locator('select').filter({ has: page.locator('option[value="exclusive"]') }).selectOption('none');
  await page.getByRole('button', { name: 'Avanti', exact: true }).first().click();

  // Passo 2: CSV destinatari
  await page.locator('input[type=file]').setInputFiles({
    name: `destinatari-${suffix}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
  await expect(page.getByText('(3 righe rilevate)')).toBeVisible();
  await page.getByRole('button', { name: 'Avanti', exact: true }).first().click();

  // Passo 3: mappatura (auto-rilevata dalle intestazioni) e validazione
  await expect(page.getByText('Tutti i 3 record sono formalmente corretti')).toBeVisible();
  await page.getByRole('button', { name: 'Procedi a Template' }).first().click();

  // Passo 4: template con segnaposto
  await page.getByPlaceholder('Es: Avviso Scadenza TARI 2026 - %%nominativo%%').fill(`Avviso ${suffix} per %%nominativo%%`);
  await page.locator('.ProseMirror').click();
  await page.keyboard.type(`Gentile %%nominativo%%, comunicazione di prova ${suffix}.`);
  await page.getByRole('button', { name: 'Riepilogo' }).first().click();

  // Passo 5: nessun allegato
  await expect(page.getByText('Passo 5: Upload Allegati', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Avanti', exact: true }).first().click();

  // Passo 6: riepilogo con anteprima risolta e lancio
  await expect(page.getByText(`Avviso ${suffix} per ROSSI MARIO`, { exact: false })).toBeVisible();
  const dialog = page.waitForEvent('dialog');
  await page.getByRole('button', { name: 'Conferma ed Avvia Campagna' }).first().click();
  const alert = await dialog;
  expect(alert.message()).toContain('avviata con successo');
  await alert.accept();

  // Stato campagna via API (stesso operatore proprietario) fino a "completed"
  const api = await Api.login('operator', 'operator');
  const campaigns = await api.get<Array<{ id: string; name: string }>>('/admin/campaigns');
  const campaign = campaigns.find((c) => c.name === campaignName);
  expect(campaign, `campagna ${campaignName} non trovata`).toBeDefined();
  await expect
    .poll(() => api.campaignStatus(campaign!.id), { timeout: 120_000, intervals: [1_000, 2_000, 5_000] })
    .toBe('completed');

  // Mailpit: esattamente i 3 messaggi della campagna, segnaposto risolti
  await expect
    .poll(async () => (await searchMessages(suffix)).length, { timeout: 30_000 })
    .toBe(3);
  const messages = await searchMessages(suffix);
  const subjects = messages.map((m) => m.Subject).sort();
  expect(subjects).toEqual(rows.map((r) => `Avviso ${suffix} per ${r.name}`).sort());
  for (const s of subjects) {
    expect(s).not.toContain('{{');
    expect(s).not.toContain('%%');
  }
  expect(messages.map((m) => m.To[0]?.Address).sort()).toEqual(rows.map((r) => r.email).sort());
});
