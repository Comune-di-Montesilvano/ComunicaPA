import { AttachmentService, resolveAttachmentsConfig, resolveCustomAttachmentFilename } from './attachment.service';
import type { Recipient } from '../entities/recipient.entity';

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
});

describe('AttachmentService.generatePdfBuffer', () => {
  let service: AttachmentService;

  beforeEach(() => {
    service = new AttachmentService();
  });

  it('genera un buffer PDF quando non c\'è allegato personalizzato per l\'indice richiesto', async () => {
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

    const buffer = await service.generatePdfBuffer(recipient);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });
});
