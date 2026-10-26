import { AttachmentService, resolveAttachmentsConfig, resolveCustomAttachmentFilename } from './attachment.service.js';
import type { Recipient } from '../entities/recipient.entity.js';

describe('resolveAttachmentsConfig', () => {
  it('legge channelConfig.attachments quando presente', () => {
    const cfg = { attachments: [{ key: 'tassa', label: 'Tassa' }, { key: 'ruolo', label: 'Ruolo' }] };
    expect(resolveAttachmentsConfig(cfg)).toEqual([
      { key: 'tassa', label: 'Tassa' },
      { key: 'ruolo', label: 'Ruolo' },
    ]);
  });

  it('ricostruisce un singolo attachment da allegatoKey legacy quando attachments è assente', () => {
    const cfg = { allegatoKey: 'documento' };
    expect(resolveAttachmentsConfig(cfg)).toEqual([{ key: 'documento', label: 'Allegato 1' }]);
  });

  it('ritorna array vuoto se non c\'è né attachments né allegatoKey', () => {
    expect(resolveAttachmentsConfig({})).toEqual([]);
    expect(resolveAttachmentsConfig(undefined)).toEqual([]);
  });
});

describe('resolveCustomAttachmentFilename con indice', () => {
  const baseRecipient = (channelConfig: Record<string, unknown>, extraData: Record<string, unknown>) =>
    ({ extraData, campaign: { channelConfig } } as unknown as Recipient);

  it('risolve il file del primo allegato (index 0) da attachments[0].key', () => {
    const r = baseRecipient(
      { attachments: [{ key: 'tassa', label: 'Tassa' }, { key: 'ruolo', label: 'Ruolo' }] },
      { tassa: 'TASSA.pdf', ruolo: 'RUOLO.pdf' },
    );
    expect(resolveCustomAttachmentFilename(r, 0)).toBe('TASSA.pdf');
  });

  it('risolve il file del secondo allegato (index 1) da attachments[1].key', () => {
    const r = baseRecipient(
      { attachments: [{ key: 'tassa', label: 'Tassa' }, { key: 'ruolo', label: 'Ruolo' }] },
      { tassa: 'TASSA.pdf', ruolo: 'RUOLO.pdf' },
    );
    expect(resolveCustomAttachmentFilename(r, 1)).toBe('RUOLO.pdf');
  });

  it('ritorna undefined per un indice fuori range', () => {
    const r = baseRecipient(
      { attachments: [{ key: 'tassa', label: 'Tassa' }] },
      { tassa: 'TASSA.pdf' },
    );
    expect(resolveCustomAttachmentFilename(r, 5)).toBeUndefined();
  });

  it('usa il fallback legacy di scansione .pdf per index 0 quando non c\'è alcuna configurazione', () => {
    const r = baseRecipient({}, { qualcheAltroCampo: 'valore', documentoAllegato: 'PREAVVISO.PDF' });
    expect(resolveCustomAttachmentFilename(r, 0)).toBe('PREAVVISO.PDF');
  });

  it('il fallback legacy NON si applica per index diverso da 0', () => {
    const r = baseRecipient({}, { documentoAllegato: 'PREAVVISO.PDF' });
    expect(resolveCustomAttachmentFilename(r, 1)).toBeUndefined();
  });

  it('index di default è 0 quando omesso (retrocompatibilità chiamanti esistenti)', () => {
    const r = baseRecipient({ allegatoKey: 'doc' }, { doc: 'X.pdf' });
    expect(resolveCustomAttachmentFilename(r)).toBe('X.pdf');
  });

  // Il valore arriva dal CSV: un path farebbe leggere (e allegare alla notifica)
  // o cancellare (retention) un file qualsiasi del container.
  it.each([
    '../../../proc/self/environ',
    '../segreto.pdf',
    'sotto/cartella.pdf',
    '/etc/passwd',
    'dir\\file.pdf',
    '..',
    '.',
  ])('nome con componenti di path (%s) → undefined', (value) => {
    const r = baseRecipient({ attachments: [{ key: 'doc', label: 'Doc' }] }, { doc: value });
    expect(resolveCustomAttachmentFilename(r, 0)).toBeUndefined();
  });

  it('fallback legacy: valore .pdf con path → undefined', () => {
    const r = baseRecipient({}, { documentoAllegato: '../../app/x.pdf' });
    expect(resolveCustomAttachmentFilename(r, 0)).toBeUndefined();
  });

  it('nome semplice con spazi e punti resta valido', () => {
    const r = baseRecipient({ attachments: [{ key: 'doc', label: 'Doc' }] }, { doc: 'AVVISO TARI 2026.v2.pdf' });
    expect(resolveCustomAttachmentFilename(r, 0)).toBe('AVVISO TARI 2026.v2.pdf');
  });
});

describe('AttachmentService.generatePdfBuffer — path traversal', () => {
  it('nome allegato con ../ → NotFound, nessuna lettura fuori da uploads', async () => {
    const r = {
      id: 'r1',
      campaignId: '00000000-0000-0000-0000-000000000001',
      extraData: { doc: '../../../../etc/hostname' },
      campaign: { channelConfig: { attachments: [{ key: 'doc', label: 'Doc' }] } },
    } as unknown as Recipient;
    await expect(new AttachmentService().generatePdfBuffer(r, 0)).rejects.toThrow('Nessun allegato');
  });
});

describe('AttachmentService.generatePdfBuffer', () => {
  let service: AttachmentService;

  beforeEach(() => {
    service = new AttachmentService();
  });

  it('lancia NotFoundException quando non c\'è allegato personalizzato per l\'indice richiesto (nessun fallback segnaposto)', async () => {
    const recipient = {
      id: 'r-1',
      campaignId: 'c-1',
      codiceFiscale: 'RSSMRA85M01H501Z',
      fullName: 'Mario Rossi',
      email: 'mario@example.com',
      pec: null,
      extraData: {},
      createdAt: new Date('2026-06-25'),
      campaign: { name: 'TARI 2026', description: 'Acconto', channelType: 'EMAIL', channelConfig: {} },
    } as unknown as Recipient;

    await expect(service.generatePdfBuffer(recipient)).rejects.toThrow('Nessun allegato configurato');
  });
});
