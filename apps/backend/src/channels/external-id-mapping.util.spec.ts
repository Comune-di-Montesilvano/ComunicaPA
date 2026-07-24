import { resolveExternalId } from './external-id-mapping.util';

describe('resolveExternalId', () => {
  it('usa la colonna mappata esplicitamente in csvMapping.externalId', () => {
    const campaign = { channelConfig: { csvMapping: { externalId: 'id_pratica' } } };
    const recipient = { extraData: { id_pratica: 'ABC-123' } };

    expect(resolveExternalId(campaign, recipient)).toBe('ABC-123');
  });

  it('fallback automatico sulla colonna "external_id" se non c\'è mappatura esplicita', () => {
    const campaign = { channelConfig: {} };
    const recipient = { extraData: { external_id: '5890000000049995' } };

    expect(resolveExternalId(campaign, recipient)).toBe('5890000000049995');
  });

  it('la mappatura esplicita ha precedenza sulla colonna convenzionale', () => {
    const campaign = { channelConfig: { csvMapping: { externalId: 'id_pratica' } } };
    const recipient = { extraData: { id_pratica: 'ABC-123', external_id: 'IGNORATO' } };

    expect(resolveExternalId(campaign, recipient)).toBe('ABC-123');
  });

  it('ritorna null se non risolvibile (né mappatura né colonna convenzionale)', () => {
    const campaign = { channelConfig: {} };
    const recipient = { extraData: {} };

    expect(resolveExternalId(campaign, recipient)).toBeNull();
  });

  it('ritorna null se il valore risolto è una stringa vuota o solo spazi', () => {
    const campaign = { channelConfig: { csvMapping: { externalId: 'id_pratica' } } };
    const recipient = { extraData: { id_pratica: '   ' } };

    expect(resolveExternalId(campaign, recipient)).toBeNull();
  });
});
