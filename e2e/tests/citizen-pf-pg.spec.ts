import { expect, test } from '@playwright/test';
import { Api, runSuffix } from '../fixtures/api';
import { DEFAULT_MAIL_CONFIG_NAME } from '../fixtures/env';
import { loginCitizen } from '../fixtures/ui';

// Flusso 2: una campagna con un destinatario persona fisica (CF) e uno impresa (P.IVA nella
// colonna codice_fiscale, come la cerca recipientKeyOf). Dal simulatore cittadino:
// accesso PF -> solo la notifica del CF; accesso per conto dell'impresa -> solo quella della P.IVA.
const CF = 'RSSMRA80A01H501U';
const PIVA = '12345678903';

const suffix = runSuffix();
const subjectPf = `Avviso ${suffix} per ROSSI MARIO`;
const subjectPg = `Avviso ${suffix} per ACME SRL`;

test.beforeAll(async () => {
  const api = await Api.login('operator', 'operator');
  const mailConfig = (await api.mailConfigs()).find((c) => c.name === DEFAULT_MAIL_CONFIG_NAME);
  expect(mailConfig, 'mail-config predefinita del globalSetup').toBeDefined();

  const campaign = await api.post<{ id: string }>('/admin/campaigns', {
    name: `E2E Cittadino ${suffix}`,
    channelType: 'EMAIL',
    channelConfig: {
      mailConfigId: mailConfig!.id,
      subject: `Avviso ${suffix} per %%nominativo%%`,
      body: `<p>Gentile %%nominativo%%, comunicazione di prova ${suffix}.</p>`,
    },
  });

  const csv = [
    'codice_fiscale,full_name,email',
    `${CF},ROSSI MARIO,rossi.${suffix}@e2e.test`,
    `${PIVA},ACME SRL,acme.${suffix}@e2e.test`,
  ].join('\n');
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), `destinatari-${suffix}.csv`);
  const upload = await api.post<{ imported: number; blocked?: boolean; message?: string }>(
    `/admin/campaigns/${campaign.id}/recipients/upload`,
    form,
  );
  expect(upload, upload.message).toMatchObject({ imported: 2 });

  const launch = await api.post<{ launched: number; blocked?: boolean; message?: string }>(
    `/admin/campaigns/${campaign.id}/launch`,
    {},
  );
  expect(launch.blocked, launch.message).toBeFalsy();
  expect(launch.launched).toBe(2);
});

test('cittadino PF vede solo la notifica del proprio codice fiscale', async ({ page }) => {
  await loginCitizen(page, { codiceFiscale: CF, name: 'Mario Rossi' });
  await page.getByPlaceholder('Cerca comunicazioni...').fill(suffix);
  await expect(page.locator('.notif-list-item-title')).toHaveText([subjectPf]);
});

test("accesso per conto di un'impresa vede solo la notifica della P.IVA", async ({ page }) => {
  // Stessa persona (CF del legale rappresentante) ma sessione impresa: conta solo la P.IVA.
  await loginCitizen(page, {
    codiceFiscale: CF,
    name: 'Mario Rossi',
    company: { ivaCode: PIVA, companyName: 'ACME SRL' },
  });
  await page.getByPlaceholder('Cerca comunicazioni...').fill(suffix);
  await expect(page.locator('.notif-list-item-title')).toHaveText([subjectPg]);
});
