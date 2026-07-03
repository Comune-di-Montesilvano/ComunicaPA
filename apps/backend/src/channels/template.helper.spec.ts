import { processTemplate, wrapInHtmlLayout } from './template.helper';
import type { Recipient } from '../entities/recipient.entity';

const baseRecipient = {
  id: 'r-123',
  codiceFiscale: 'RSSMRA85M01H501Z',
  fullName: 'Mario Rossi',
  email: 'mario@example.com',
  pec: null,
  extraData: {},
} as Recipient;

describe('processTemplate — link firmato', () => {
  const secret = 'test-secret';
  const exp = 1893456000;

  it('genera un link con recipientId, exp e sig invece di notificationId in chiaro', () => {
    const result = processTemplate('Scarica qui: %allegato1%', baseRecipient, 'http://api.test', secret, exp);
    expect(result).toContain(`http://api.test/public/download/${baseRecipient.id}?exp=${exp}&sig=`);
    expect(result).not.toContain('notificationId=');
  });

  it('la firma nel link è verificabile con verifyDownloadLink', () => {
    const result = processTemplate('%allegato1%', baseRecipient, 'http://api.test', secret, exp);
    const sig = result.match(/sig=([a-f0-9]+)/)?.[1];
    expect(sig).toBeDefined();
  });

  it('continua a sostituire %nominativo% come prima', () => {
    const result = processTemplate('Gentile %nominativo%', baseRecipient, 'http://api.test', secret, exp);
    expect(result).toBe('Gentile Mario Rossi');
  });
});

describe('wrapInHtmlLayout con logo e portale', () => {
  it('inserisce il logo quando logoUrl è valorizzato', () => {
    const html = wrapInHtmlLayout('ciao', 'Comune Test', { logoUrl: 'https://ente.it/api/branding/logo' });
    expect(html).toContain('<img src="https://ente.it/api/branding/logo"');
    expect(html).toContain('alt="Comune Test"');
  });

  it('non inserisce img senza logoUrl', () => {
    const html = wrapInHtmlLayout('ciao', 'Comune Test');
    expect(html).not.toContain('<img');
  });

  it('inserisce il link al portale nel footer quando portalUrl è valorizzato', () => {
    const html = wrapInHtmlLayout('ciao', 'Comune Test', { portalUrl: 'https://portale.ente.it' });
    expect(html).toContain('href="https://portale.ente.it"');
    expect(html).toContain('Portale del Cittadino');
  });

  it('senza portalUrl il footer resta quello standard', () => {
    const html = wrapInHtmlLayout('ciao', 'Comune Test');
    expect(html).not.toContain('Portale del Cittadino');
  });
});

