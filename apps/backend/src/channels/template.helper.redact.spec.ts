import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { Recipient } from '../entities/recipient.entity.js';

const signSpy = vi.hoisted(() => vi.fn());
vi.mock('./download-link.util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./download-link.util.js')>();
  return {
    ...actual,
    signDownloadLink: (...args: Parameters<typeof actual.signDownloadLink>) => {
      signSpy(...args);
      return actual.signDownloadLink(...args);
    },
  };
});

import { processTemplate } from './template.helper.js';

const recipient = {
  id: 'r-123',
  codiceFiscale: 'RSSMRA80A01H501U',
  fullName: 'ROSSI MARIO',
  email: null,
  pec: null,
  extraData: {},
} as unknown as Recipient;

const exp = 1893456000;

describe('processTemplate — redactDownloadLinks (anteprime backoffice riservate)', () => {
  beforeEach(() => signSpy.mockClear());

  it('true: %%allegatoN%% e %%elenco_allegati%% diventano #allegato-riservato, nessuna firma generata', () => {
    const tpl = 'A: %%allegato1%% B: %%allegato2%% %%elenco_allegati%%';
    const html = processTemplate(tpl, recipient, 'http://api.test', 'secret', exp, ['Avviso', 'Ruolo'], 'html', 'EMAIL', true, true);
    const md = processTemplate(tpl, recipient, 'http://api.test', 'secret', exp, ['Avviso', 'Ruolo'], 'markdown', 'APP_IO', true, true);
    for (const out of [html, md]) {
      expect(out).toContain('#allegato-riservato');
      expect(out).not.toContain('public/download');
      expect(out).not.toContain('sig=');
    }
    expect(signSpy).not.toHaveBeenCalled();
  });

  it('false (default): link firmato come oggi', () => {
    const tpl = 'A: %%allegato1%%';
    const withDefault = processTemplate(tpl, recipient, 'http://api.test', 'secret', exp, ['Avviso'], 'html', 'EMAIL', true);
    const explicit = processTemplate(tpl, recipient, 'http://api.test', 'secret', exp, ['Avviso'], 'html', 'EMAIL', true, false);
    expect(explicit).toBe(withDefault);
    expect(explicit).toContain('/public/download/r-123/0?exp=');
    expect(explicit).toContain('sig=');
    expect(signSpy).toHaveBeenCalled();
  });
});
