import { CitizenController } from './citizen.controller.js';

describe('CitizenController — filtro destinatari per tipo di accesso', () => {
  const citizenService = {
    findAllForCitizen: jest.fn(async () => []),
    findOneForCitizen: jest.fn(async () => ({})),
  };
  const controller = new CitizenController(citizenService as never, {} as never);

  beforeEach(() => jest.clearAllMocks());

  it('persona fisica: notifiche cercate per codice fiscale', async () => {
    await controller.findAll({ user: { sub: 's', codiceFiscale: 'RSSMRA85M01H501Z', accessType: 'PF' } });
    expect(citizenService.findAllForCitizen).toHaveBeenCalledWith('RSSMRA85M01H501Z');
  });

  it('operatore per impresa: notifiche e dettaglio cercati per P.IVA, mai per il CF della persona', async () => {
    const user = { sub: 's', codiceFiscale: 'RSSMRA85M01H501Z', accessType: 'PG' as const, ivaCode: '01234567890', companyName: 'ACME SRL' };
    await controller.findAll({ user });
    expect(citizenService.findAllForCitizen).toHaveBeenCalledWith('01234567890');

    await controller.findOne('00000000-0000-0000-0000-000000000001', { user });
    expect(citizenService.findOneForCitizen).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000001', '01234567890');
  });
});

describe('CitizenController — documenti SEND solo della propria notifica', () => {
  const user = { sub: 's', codiceFiscale: 'RSSMRA85M01H501Z', accessType: 'PF' as const };
  const id = '00000000-0000-0000-0000-000000000001';
  const pdf = { ready: true, filename: 'atto.pdf', contentType: 'application/pdf', buffer: Buffer.from('%PDF') };
  const makeRes = () => ({ setHeader: jest.fn(), end: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() });

  it('usa lo IUN della notifica del cittadino, mai quello passato in query (IDOR)', async () => {
    const citizenService = {
      findOneForCitizen: jest.fn(async () => ({ iun: 'AAAA-BBBB-CCCC-202610-A-1' })),
      markAsDownloaded: jest.fn(async () => ({})),
    };
    const sendLegalFacts = { downloadLegalFact: jest.fn(async () => pdf) };
    const controller = new CitizenController(citizenService as never, sendLegalFacts as never);

    await controller.downloadSendDocument(id, 'ZZZZ-YYYY-XXXX-202610-B-1', 'PN_LEGAL_FACTS-abc', { user }, makeRes() as never);

    expect(sendLegalFacts.downloadLegalFact).toHaveBeenCalledWith('AAAA-BBBB-CCCC-202610-A-1', 'PN_LEGAL_FACTS-abc');
  });

  it('notifica senza IUN SEND → 404, nessuna chiamata a PN', async () => {
    const citizenService = { findOneForCitizen: jest.fn(async () => ({ iun: null })), markAsDownloaded: jest.fn() };
    const sendLegalFacts = { downloadLegalFact: jest.fn() };
    const controller = new CitizenController(citizenService as never, sendLegalFacts as never);

    await expect(controller.downloadSendDocument(id, 'ZZZZ-YYYY-XXXX-202610-B-1', 'k', { user }, makeRes() as never)).rejects.toThrow();
    expect(sendLegalFacts.downloadLegalFact).not.toHaveBeenCalled();
  });

  it('legalFactId ripetuto in query (array) → rifiutato', async () => {
    const citizenService = { findOneForCitizen: jest.fn(async () => ({ iun: 'AAAA-BBBB-CCCC-202610-A-1' })), markAsDownloaded: jest.fn() };
    const sendLegalFacts = { downloadLegalFact: jest.fn() };
    const controller = new CitizenController(citizenService as never, sendLegalFacts as never);

    await expect(controller.downloadSendDocument(id, undefined as never, ['a', 'b'] as never, { user }, makeRes() as never)).rejects.toThrow();
    expect(sendLegalFacts.downloadLegalFact).not.toHaveBeenCalled();
  });
});
