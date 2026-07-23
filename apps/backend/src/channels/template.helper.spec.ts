import { processTemplate, wrapInHtmlLayout, hasValidAttachmentPlaceholders } from './template.helper';
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

  it('sostituisce %%allegato1%% con un link all\'indice 0 quando c\'è un allegato configurato', () => {
    const result = processTemplate('Scarica qui: %%allegato1%%', baseRecipient, 'http://api.test', secret, exp, ['Tassa']);
    expect(result).toContain(`http://api.test/public/download/${baseRecipient.id}/0?exp=${exp}&sig=`);
  });

  it('sostituisce %%allegato1%% e %%allegato2%% con link a indici distinti', () => {
    const result = processTemplate('%%allegato1%% e %%allegato2%%', baseRecipient, 'http://api.test', secret, exp, ['Tassa', 'Ruolo']);
    expect(result).toContain(`/public/download/${baseRecipient.id}/0?exp=${exp}&sig=`);
    expect(result).toContain(`/public/download/${baseRecipient.id}/1?exp=${exp}&sig=`);
  });

  it('senza attachmentLabels, %%allegato1%% NON viene sostituito (nessun allegato configurato)', () => {
    const result = processTemplate('Link: %%allegato1%%', baseRecipient, 'http://api.test', secret, exp);
    expect(result).toBe('Link: %%allegato1%%');
  });

  it('continua a sostituire %%nominativo%% come prima', () => {
    const result = processTemplate('Gentile %%nominativo%%', baseRecipient, 'http://api.test', secret, exp);
    expect(result).toBe('Gentile Mario Rossi');
  });

  it('aggiunge &ch=EMAIL al link quando sourceChannel è passato', () => {
    const result = processTemplate('Scarica: %%allegato1%%', baseRecipient, 'http://api.test', secret, exp, ['Tassa'], 'html', 'EMAIL');
    expect(result).toContain('&ch=EMAIL');
  });

  it('senza sourceChannel il link non contiene &ch= (retrocompatibile)', () => {
    const result = processTemplate('Scarica: %%allegato1%%', baseRecipient, 'http://api.test', secret, exp, ['Tassa']);
    expect(result).not.toContain('&ch=');
  });
});

describe('processTemplate — macro %%elenco_allegati%%', () => {
  const secret = 'test-secret';
  const exp = 1893456000;

  it('formato html: genera un blocco per ogni allegato con etichetta e bottone di download evidente', () => {
    const result = processTemplate('%%elenco_allegati%%', baseRecipient, 'http://api.test', secret, exp, ['Tassa', 'Ruolo'], 'html');
    expect(result).toContain('<table');
    expect(result).toContain('Tassa');
    expect(result).toContain('Ruolo');
    expect(result).toContain(`/public/download/${baseRecipient.id}/0?exp=${exp}&sig=`);
    expect(result).toContain(`/public/download/${baseRecipient.id}/1?exp=${exp}&sig=`);
    // Il link di download deve essere un bottone prominente (colore brand), non un semplice testo sottolineato
    expect(result).toContain('background-color:#0066cc');
    expect(result).toContain('border-radius');
    // Un blocco/card distinto per ogni allegato (non una singola tabella con righe multiple)
    expect((result.match(/<table/g) || []).length).toBe(2);
  });

  it('formato markdown: genera un elenco puntato senza tag HTML (nessuna riga vuota residua se e l\'unico contenuto)', () => {
    const result = processTemplate('%%elenco_allegati%%', baseRecipient, 'http://api.test', secret, exp, ['Tassa'], 'markdown');
    expect(result).toBe(`- **Tassa**: [Scarica](http://api.test/public/download/${baseRecipient.id}/0?exp=${exp}&sig=${result.match(/sig=([a-f0-9]+)/)?.[1]})`);
    expect(result).not.toContain('<table');
    expect(result).not.toContain('<td');
  });

  it('formato markdown: anche senza riga vuota nel template sorgente, resta garantita una separazione dal testo successivo (bug App IO)', () => {
    const result = processTemplate('%%elenco_allegati%%\nTesto successivo.', baseRecipient, 'http://api.test', secret, exp, ['Tassa'], 'markdown');
    expect(result).toContain('Scarica](');
    expect(result).toMatch(/\)\n\n+Testo successivo\.$/);
  });

  it('nessun allegato configurato: la macro si espande in stringa vuota', () => {
    const result = processTemplate('Prima %%elenco_allegati%% Dopo', baseRecipient, 'http://api.test', secret, exp, []);
    expect(result).toBe('Prima  Dopo');
  });
});

describe('processTemplate — carattere % letterale nel testo', () => {
  const secret = 'test-secret';
  const exp = 1893456000;

  it('un "%" singolo (percentuale) non viene mai scambiato per placeholder', () => {
    const result = processTemplate(
      "Corrisponde al 60% per cento del tributo dovuto per l'anno in corso, contro l'80% dell'anno precedente.",
      baseRecipient,
      'http://api.test',
      secret,
      exp,
    );
    expect(result).toBe("Corrisponde al 60% per cento del tributo dovuto per l'anno in corso, contro l'80% dell'anno precedente.");
  });

  it('un vero placeholder %%nominativo%% tra due "%" letterali continua a funzionare', () => {
    const result = processTemplate('60% per %%nominativo%%, 80% totale', baseRecipient, 'http://api.test', secret, exp);
    expect(result).toBe('60% per Mario Rossi, 80% totale');
  });

  it('chiave con spazi e due punti (colonna CSV "Pagamento: importo notifica") viene risolta', () => {
    const recipient = { ...baseRecipient, extraData: { 'Pagamento: importo notifica': '67,00' } } as Recipient;
    const result = processTemplate('Importo: %%Pagamento: importo notifica%%', recipient, 'http://api.test', secret, exp);
    expect(result).toBe('Importo: 67,00');
  });

  it('risolve il token %%numero_protocollo%% se attaccato temporaneamente all\'oggetto recipient', () => {
    const recipient = { ...baseRecipient } as any;
    recipient.protocolNumber = '5566/2026';
    const result = processTemplate('Protocollo: %%numero_protocollo%%', recipient, 'http://api.test', secret, exp);
    expect(result).toBe('Protocollo: 5566/2026');
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
    const htmlBody = '<p>Gentile <strong>%%nominativo%%</strong>,</p><p>ecco il link:</p><p><a href="http://link">clicca qui</a></p><ul><li>item 1</li><li>item 2</li></ul>';
    const result = processTemplate(htmlBody, baseRecipient, 'http://api.test', 'secret', 1893456000, [], 'markdown');
    expect(result).toBe('Gentile **Mario Rossi**,\n\necco il link:\n\n[clicca qui](http://link)\n\n- item 1\n- item 2');
  });

  it('formato markdown: preserva markdown pre-esistente se non ci sono tag HTML', () => {
    const markdownBody = 'Gentile **%%nominativo%%**,\n\n- item 1\n- item 2';
    const result = processTemplate(markdownBody, baseRecipient, 'http://api.test', 'secret', 1893456000, [], 'markdown');
    expect(result).toBe('Gentile **Mario Rossi**,\n\n- item 1\n- item 2');
  });

  it('formato markdown: rimuove eventuali altri tag HTML non supportati', () => {
    const htmlBody = '<p>Gentile %%nominativo%%</p><div>test</div><span>altro</span>';
    const result = processTemplate(htmlBody, baseRecipient, 'http://api.test', 'secret', 1893456000, [], 'markdown');
    expect(result).toBe('Gentile Mario Rossi\n\ntestaltro');
  });
});

describe('hasValidAttachmentPlaceholders', () => {
  it('è sempre valido se non ci sono allegati (count 0)', () => {
    expect(hasValidAttachmentPlaceholders('Nessun placeholder qui', 0)).toBe(true);
    expect(hasValidAttachmentPlaceholders('', 0)).toBe(true);
  });

  it('è valido se il body contiene %%elenco_allegati%%', () => {
    expect(hasValidAttachmentPlaceholders('Vedi %%elenco_allegati%% in fondo', 2)).toBe(true);
  });

  it('è valido se il body contiene TUTTI i singoli %%allegatoN%% richiesti', () => {
    expect(hasValidAttachmentPlaceholders('%%allegato1%% e %%allegato2%%', 2)).toBe(true);
  });

  it('non è valido se manca anche un solo %%allegatoN%% (singoli parziali)', () => {
    expect(hasValidAttachmentPlaceholders('Solo %%allegato1%%', 2)).toBe(false);
  });

  it('non è valido se il body non contiene né elenco né singoli', () => {
    expect(hasValidAttachmentPlaceholders('Gentile %%nominativo%%, saluti.', 1)).toBe(false);
  });
});
