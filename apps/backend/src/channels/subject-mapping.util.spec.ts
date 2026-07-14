import { resolveSubjectTemplate } from './subject-mapping.util';

describe('resolveSubjectTemplate', () => {
  it('usa il valore per-destinatario quando csvMapping.subject è configurato e la cella non è vuota', () => {
    const campaign = { name: 'TARI 2026', channelConfig: { subject: 'Template generico', csvMapping: { subject: 'oggetto_riga' } } };
    const recipient = { extraData: { oggetto_riga: 'Avviso specifico riga 1' } };

    expect(resolveSubjectTemplate(campaign, recipient)).toBe('Avviso specifico riga 1');
  });

  it('usa il fallback al template generico se la colonna è mappata ma la cella è vuota', () => {
    const campaign = { name: 'TARI 2026', channelConfig: { subject: 'Template generico', csvMapping: { subject: 'oggetto_riga' } } };
    const recipient = { extraData: { oggetto_riga: '' } };

    expect(resolveSubjectTemplate(campaign, recipient)).toBe('Template generico');
  });

  it('usa il template generico se csvMapping.subject non è configurato', () => {
    const campaign = { name: 'TARI 2026', channelConfig: { subject: 'Template generico' } };
    const recipient = { extraData: { oggetto_riga: 'Ignorato' } };

    expect(resolveSubjectTemplate(campaign, recipient)).toBe('Template generico');
  });

  it('usa campaign.name come ultimo fallback se non c\'è nemmeno il template generico', () => {
    const campaign = { name: 'TARI 2026', channelConfig: {} };
    const recipient = { extraData: {} };

    expect(resolveSubjectTemplate(campaign, recipient)).toBe('TARI 2026');
  });
});
