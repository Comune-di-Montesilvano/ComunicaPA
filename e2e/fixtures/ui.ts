import { expect, type Locator, type Page } from '@playwright/test';
import { ADMIN_URL, CITIZEN_URL } from './env';

/** Login operatore dal portale admin (LDAP_HOST=mock: admin/admin, operator/operator). */
export async function loginAdmin(page: Page, username: string, password: string): Promise<void> {
  await page.goto(ADMIN_URL);
  await page.getByLabel('Utente (sAMAccountName)').fill(username);
  await page.getByLabel('Password AD/LDAP').fill(password);
  await page.getByRole('button', { name: 'Accedi con Active Directory' }).click();
  await expect(page.locator('nav.bo-nav')).toBeVisible();
}

/** Voce della sidebar admin. */
export function sidebarLink(page: Page, name: string): Locator {
  return page.locator('nav.bo-nav').getByRole('link', { name, exact: true });
}

/**
 * Card piu' interna che contiene il testo: le card della pagina possono essere annidate e in
 * ordine DOM gli antenati vengono prima dei discendenti.
 */
export function innermostCard(page: Page, text: string): Locator {
  return page.locator('div.card').filter({ hasText: text }).last();
}

export interface CitizenIdentity {
  codiceFiscale: string;
  name: string;
  /** Accesso per conto di un'impresa (SPID persona giuridica simulato). */
  company?: { ivaCode: string; companyName: string };
}

/** Login dal simulatore SPID/CIE del portale cittadini (solo LDAP_HOST=mock). */
export async function loginCitizen(page: Page, who: CitizenIdentity): Promise<void> {
  await page.goto(CITIZEN_URL);
  await page.getByLabel('Inserisci Codice Fiscale personalizzato').check();
  await page.getByPlaceholder('Codice Fiscale (16 caratteri)').fill(who.codiceFiscale);
  await page.getByPlaceholder('Nome e Cognome').fill(who.name);
  if (who.company) {
    await page.getByLabel("Accedi per conto di un'impresa").check();
    await page.getByPlaceholder('P.IVA').fill(who.company.ivaCode);
    await page.getByPlaceholder('Ragione sociale').fill(who.company.companyName);
  }
  await page.getByRole('button', { name: 'Entra con SPID' }).click();
  await expect(page.getByPlaceholder('Cerca comunicazioni...')).toBeVisible();
}
