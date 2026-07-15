import { Test } from '@nestjs/testing';
import { PostalStrategy } from './postal.strategy';
import { GlobalComClient } from './globalcom-client.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { AttachmentService } from '../../attachments/attachment.service';

describe('PostalStrategy', () => {
  let strategy: PostalStrategy;
  let globalCom: jest.Mocked<GlobalComClient>;
  let settings: jest.Mocked<AppSettingsService>;
  let attachments: jest.Mocked<AttachmentService>;

  const baseRecipient = {
    id: 'recipient-1',
    codiceFiscale: 'RSSMRA85M01H501Z',
    fullName: 'Mario Rossi',
    email: null,
    pec: null,
    extraData: { indirizzo: 'Via Roma 1', comune: 'Montesilvano', cap: '65015', prov: 'PE' },
  };

  const settingsMap: Record<string, unknown> = {
    'postal.baseUrl': 'https://esempio.corrispondenzadigitale.it/gbcweb/GBCWebservice.asmx',
    'postal.user': 'user1',
    'postal.password': 'pass1',
    'postal.group': 'group1',
    'postal.centroDiCosto': '',
    'postal.mittente.denominazione1': '',
    'postal.mittente.indirizzo1': '',
    'postal.mittente.cap': '',
    'postal.mittente.citta': '',
    'postal.mittente.provincia': '',
  };

  function baseCampaign(overrides: Record<string, unknown> = {}) {
    return {
      id: 'campaign-1',
      name: 'TARI 2026',
      channelConfig: {
        postalServiceType: 'Raccomandata',
        postalReturnReceipt: true,
        physicalAddressConfig: {
          enabled: true,
          addressColumn: 'indirizzo',
          municipalityColumn: 'comune',
          zipColumn: 'cap',
          provinceColumn: 'prov',
        },
        ...overrides,
      },
    };
  }

  beforeEach(async () => {
    const mockGlobalCom = {
      invioExtSingolo: jest.fn(),
      cercaPerTesto: jest.fn(),
      dettagliDocumento: jest.fn(),
    };
    const mockSettings = { get: jest.fn(async (key: string) => settingsMap[key]) };
    const mockAttachments = { generatePdfBuffer: jest.fn(async () => Buffer.from('%PDF-1.4 test')) };

    const module = await Test.createTestingModule({
      providers: [
        PostalStrategy,
        { provide: GlobalComClient, useValue: mockGlobalCom },
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: AttachmentService, useValue: mockAttachments },
      ],
    }).compile();

    strategy = module.get(PostalStrategy);
    globalCom = module.get(GlobalComClient);
    settings = module.get(AppSettingsService) as any;
    attachments = module.get(AttachmentService) as any;
    void settings;
  });

  it('is defined with channel POSTAL', () => {
    expect(strategy.channel).toBe('POSTAL');
  });

  it('send() invia via GlobalCom e ritorna messageId=IDPRO', async () => {
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO123', stato: 'Accettato' });

    const result = await strategy.send(baseRecipient as never, baseCampaign() as never, undefined, 'attempt-uuid-1', 0);

    expect(attachments.generatePdfBuffer).toHaveBeenCalledWith(baseRecipient, 0);
    expect(globalCom.invioExtSingolo).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: settingsMap['postal.baseUrl'], user: 'user1' }),
      expect.objectContaining({
        servizio: 'Raccomandata',
        ricevutaDiRitorno: true,
        mittente: null,
        note: 'recipient-1',
        destinatario: expect.objectContaining({ indirizzo1: 'Via Roma 1', citta: 'Montesilvano', cap: '65015', provincia: 'PE' }),
      }),
    );
    expect(result.messageId).toBe('IDPRO123');
    expect(result.responsePayload).toEqual({ stato: 'Accettato', idPro: 'IDPRO123' });
  });

  it('send() lancia se indirizzo destinatario non risolvibile', async () => {
    const recipientSenzaIndirizzo = { ...baseRecipient, extraData: {} };

    await expect(
      strategy.send(recipientSenzaIndirizzo as never, baseCampaign() as never, undefined, 'attempt-uuid-2', 0),
    ).rejects.toThrow(/indirizzo destinatario non risolvibile/);
    expect(globalCom.invioExtSingolo).not.toHaveBeenCalled();
  });

  it('send() lancia se GlobalCom risponde Stato=Errore', async () => {
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO999', stato: 'Errore', codiceErrore: 'E01', descrizione: 'CAP non valido' });

    await expect(
      strategy.send(baseRecipient as never, baseCampaign() as never, undefined, 'attempt-uuid-3', 0),
    ).rejects.toThrow(/CAP non valido/);
  });

  it('send() al primo tentativo (attemptsMade=0) NON cerca dedup su GlobalCom', async () => {
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Accettato' });

    await strategy.send(baseRecipient as never, baseCampaign() as never, undefined, 'attempt-uuid-4', 0);

    expect(globalCom.cercaPerTesto).not.toHaveBeenCalled();
  });

  it('send() su retry (attemptsMade>0) trova un invio già presente e non reinvia', async () => {
    globalCom.cercaPerTesto.mockResolvedValue([{ idPro: 'IDPRO-ESISTENTE', stato: 'Consegnato' }]);

    const result = await strategy.send(baseRecipient as never, baseCampaign() as never, undefined, 'attempt-uuid-5', 1);

    expect(globalCom.cercaPerTesto).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: settingsMap['postal.baseUrl'] }),
      'recipient-1',
    );
    expect(globalCom.invioExtSingolo).not.toHaveBeenCalled();
    expect(result.messageId).toBe('IDPRO-ESISTENTE');
  });

  it('send() su retry manuale (attemptsMade=0 ma recipient.attemptNumber>1) cerca comunque dedup su GlobalCom', async () => {
    globalCom.cercaPerTesto.mockResolvedValue([{ idPro: 'IDPRO-ESISTENTE', stato: 'Consegnato' }]);
    const recipienteRetryManuale = { ...baseRecipient, attemptNumber: 2 };

    const result = await strategy.send(recipienteRetryManuale as never, baseCampaign() as never, undefined, 'attempt-uuid-manual-retry', 0);

    expect(globalCom.cercaPerTesto).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: settingsMap['postal.baseUrl'] }),
      'recipient-1',
    );
    expect(globalCom.invioExtSingolo).not.toHaveBeenCalled();
    expect(result.messageId).toBe('IDPRO-ESISTENTE');
  });

  it('send() al primo attempt in assoluto (attemptsMade=0, attemptNumber assente) NON cerca dedup su GlobalCom', async () => {
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Accettato' });

    await strategy.send(baseRecipient as never, baseCampaign() as never, undefined, 'attempt-uuid-first', 0);

    expect(globalCom.cercaPerTesto).not.toHaveBeenCalled();
  });

  it('send() su retry con solo esiti Errore/Eliminato precedenti reinvia normalmente', async () => {
    globalCom.cercaPerTesto.mockResolvedValue([{ idPro: 'IDPRO-VECCHIO', stato: 'Errore' }]);
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO-NUOVO', stato: 'Accettato' });

    const result = await strategy.send(baseRecipient as never, baseCampaign() as never, undefined, 'attempt-uuid-6', 1);

    expect(globalCom.invioExtSingolo).toHaveBeenCalled();
    expect(result.messageId).toBe('IDPRO-NUOVO');
  });

  it('send() usa Mittente esplicito se configurato nelle settings', async () => {
    settingsMap['postal.mittente.denominazione1'] = 'Comune di Montesilvano';
    settingsMap['postal.mittente.indirizzo1'] = 'Via Roma 1';
    settingsMap['postal.mittente.cap'] = '65016';
    settingsMap['postal.mittente.citta'] = 'Montesilvano';
    settingsMap['postal.mittente.provincia'] = 'PE';
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Accettato' });

    await strategy.send(baseRecipient as never, baseCampaign() as never, undefined, 'attempt-uuid-7', 0);

    expect(globalCom.invioExtSingolo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mittente: expect.objectContaining({ denominazione1: 'Comune di Montesilvano' }) }),
    );

    settingsMap['postal.mittente.denominazione1'] = '';
    settingsMap['postal.mittente.indirizzo1'] = '';
    settingsMap['postal.mittente.cap'] = '';
    settingsMap['postal.mittente.citta'] = '';
    settingsMap['postal.mittente.provincia'] = '';
  });

  it('send() passa UserData1 da userDataColumn quando configurato', async () => {
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Accettato' });
    const recipientConCodice = { ...baseRecipient, extraData: { ...baseRecipient.extraData, numero_avviso: 'AV-2026-001' } };

    await strategy.send(
      recipientConCodice as never,
      baseCampaign({ userDataColumn: 'numero_avviso' }) as never,
      undefined, 'attempt-uuid-8', 0,
    );

    expect(globalCom.invioExtSingolo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userData1: 'AV-2026-001' }),
    );
  });

  it('send() passa Protocollo se protocollazione già avvenuta', async () => {
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Accettato' });
    const recipientConProtocollo = { ...baseRecipient, protocolNumber: '42/2026' };

    await strategy.send(recipientConProtocollo as never, baseCampaign() as never, undefined, 'attempt-uuid-9', 0);

    expect(globalCom.invioExtSingolo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ protocollo: '42/2026' }),
    );
  });
});
