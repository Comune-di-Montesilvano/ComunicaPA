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

describe('processTemplate — link firmato con indice allegato', () => {
  const secret = 'test-secret';
  const exp = 1893456000;

  it('sostituisce %allegato1% con un link all\'indice 0 quando c\'è un allegato configurato', () => {
    const result = processTemplate('Scarica qui: %allegato1%', baseRecipient, 'http://api.test', secret, exp, ['Tassa']);
    expect(result).toContain(`http://api.test/public/download/${baseRecipient.id}/0?exp=${exp}&sig=`);
  });

  it('sostituisce %allegato1% e %allegato2% con link a indici distinti', () => {
    const result = processTemplate('%allegato1% e %allegato2%', baseRecipient, 'http://api.test', secret, exp, ['Tassa', 'Ruolo']);
    expect(result).toContain(`/public/download/${baseRecipient.id}/0?exp=${exp}&sig=`);
    expect(result).toContain(`/public/download/${baseRecipient.id}/1?exp=${exp}&sig=`);
  });

  it('senza attachmentLabels, %allegato1% NON viene sostituito (nessun allegato configurato)', () => {
    const result = processTemplate('Link: %allegato1%', baseRecipient, 'http://api.test', secret, exp);
    expect(result).toBe('Link: %allegato1%');
  });

  it('continua a sostituire %nominativo% come prima', () => {
    const result = processTemplate('Gentile %nominativo%', baseRecipient, 'http://api.test', secret, exp);
    expect(result).toBe('Gentile Mario Rossi');
  });

  it('aggiunge &ch=EMAIL al link quando sourceChannel è passato', () => {
    const result = processTemplate('Scarica: %allegato1%', baseRecipient, 'http://api.test', secret, exp, ['Tassa'], 'html', 'EMAIL');
    expect(result).toContain('&ch=EMAIL');
  });

  it('senza sourceChannel il link non contiene &ch= (retrocompatibile)', () => {
    const result = processTemplate('Scarica: %allegato1%', baseRecipient, 'http://api.test', secret, exp, ['Tassa']);
    expect(result).not.toContain('&ch=');
  });
});

describe('processTemplate — macro %elenco_allegati%', () => {
  const secret = 'test-secret';
  const exp = 1893456000;

  it('formato html: genera una tabella con etichetta e link per ogni allegato', () => {
    const result = processTemplate('%elenco_allegati%', baseRecipient, 'http://api.test', secret, exp, ['Tassa', 'Ruolo'], 'html');
    expect(result).toContain('<table');
    expect(result).toContain('Tassa');
    expect(result).toContain('Ruolo');
    expect(result).toContain(`/public/download/${baseRecipient.id}/0?exp=${exp}&sig=`);
    expect(result).toContain(`/public/download/${baseRecipient.id}/1?exp=${exp}&sig=`);
  });

  it('formato markdown: genera un elenco puntato senza tag HTML', () => {
    const result = processTemplate('%elenco_allegati%', baseRecipient, 'http://api.test', secret, exp, ['Tassa'], 'markdown');
    expect(result).toBe(`- **Tassa**: [Scarica](http://api.test/public/download/${baseRecipient.id}/0?exp=${exp}&sig=${result.match(/sig=([a-f0-9]+)/)?.[1]})`);
    expect(result).not.toContain('<table');
    expect(result).not.toContain('<td');
  });

  it('nessun allegato configurato: la macro si espande in stringa vuota', () => {
    const result = processTemplate('Prima %elenco_allegati% Dopo', baseRecipient, 'http://api.test', secret, exp, []);
    expect(result).toBe('Prima  Dopo');
  });
});

describe('processTemplate — carattere % letterale nel testo', () => {
  const secret = 'test-secret';
  const exp = 1893456000;

  it('un solo "%" nel testo non viene toccato', () => {
    const result = processTemplate('Corrisponde al 60% del tributo dovuto.', baseRecipient, 'http://api.test', secret, exp);
    expect(result).toBe('Corrisponde al 60% del tributo dovuto.');
  });

  it('due "%" separati da spazi non formano un placeholder e restano letterali', () => {
    const result = processTemplate(
      "Corrisponde al 60% per cento del tributo dovuto per l'anno in corso, contro l'80% dell'anno precedente.",
      baseRecipient,
      'http://api.test',
      secret,
      exp,
    );
    expect(result).toBe("Corrisponde al 60% per cento del tributo dovuto per l'anno in corso, contro l'80% dell'anno precedente.");
  });

  it('un vero placeholder %nominativo% tra due "%" letterali continua a funzionare', () => {
    const result = processTemplate('60% per %nominativo%, 80% totale', baseRecipient, 'http://api.test', secret, exp);
    expect(result).toBe('60% per Mario Rossi, 80% totale');
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

describe('processTemplate — html to markdown conversion', () => {
  it('formato markdown: converte i tag HTML del WYSIWYG editor in markdown pulito', () => {
    const htmlBody = '<p>Gentile <strong>%nominativo%</strong>,</p><p>ecco il link:</p><p><a href="http://link">clicca qui</a></p><ul><li>item 1</li><li>item 2</li></ul>';
    const result = processTemplate(htmlBody, baseRecipient, 'http://api.test', 'secret', 1893456000, [], 'markdown');
    expect(result).toBe('Gentile **Mario Rossi**,\n\necco il link:\n\n[clicca qui](http://link)\n\n- item 1\n- item 2');
  });

  it('formato markdown: preserva markdown pre-esistente se non ci sono tag HTML', () => {
    const markdownBody = 'Gentile **%nominativo%**,\n\n- item 1\n- item 2';
    const result = processTemplate(markdownBody, baseRecipient, 'http://api.test', 'secret', 1893456000, [], 'markdown');
    expect(result).toBe('Gentile **Mario Rossi**,\n\n- item 1\n- item 2');
  });

  it('formato markdown: rimuove eventuali altri tag HTML non supportati', () => {
    const htmlBody = '<p>Gentile %nominativo%</p><div>test</div><span>altro</span>';
    const result = processTemplate(htmlBody, baseRecipient, 'http://api.test', 'secret', 1893456000, [], 'markdown');
    expect(result).toBe('Gentile Mario Rossi\n\ntestaltro');
  });
});
