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

describe('CitizenController — notifica SEND: solo il link a SEND', () => {
  const user = { sub: 's', codiceFiscale: 'RSSMRA85M01H501Z', accessType: 'PF' as const };
  const id = '00000000-0000-0000-0000-000000000001';

  it("QR dell'avviso letto → link diretto alla notifica, IUN preso dalla notifica del cittadino", async () => {
    const citizenService = { findOneForCitizen: jest.fn(async () => ({ iun: 'AAAA-BBBB-CCCC-202610-A-1' })) };
    const sendLegalFacts = { getQuickAccessUrl: jest.fn(async () => 'https://cittadini.notifichedigitali.it/io/?aar=abc') };
    const controller = new CitizenController(citizenService as never, sendLegalFacts as never);

    await expect(controller.getSendLink(id, { user })).resolves.toEqual({ url: 'https://cittadini.notifichedigitali.it/io/?aar=abc', direct: true });
    expect(citizenService.findOneForCitizen).toHaveBeenCalledWith(id, 'RSSMRA85M01H501Z');
    expect(sendLegalFacts.getQuickAccessUrl).toHaveBeenCalledWith('AAAA-BBBB-CCCC-202610-A-1');
  });

  it('QR non letto → portale cittadini SEND', async () => {
    const citizenService = { findOneForCitizen: jest.fn(async () => ({ iun: 'AAAA-BBBB-CCCC-202610-A-1' })) };
    const sendLegalFacts = { getQuickAccessUrl: jest.fn(async () => null) };
    const controller = new CitizenController(citizenService as never, sendLegalFacts as never);

    await expect(controller.getSendLink(id, { user })).resolves.toEqual({ url: 'https://cittadini.notifichedigitali.it/', direct: false });
  });

  it('notifica senza IUN → portale cittadini SEND, nessuna chiamata a PN', async () => {
    const citizenService = { findOneForCitizen: jest.fn(async () => ({ iun: null })) };
    const sendLegalFacts = { getQuickAccessUrl: jest.fn() };
    const controller = new CitizenController(citizenService as never, sendLegalFacts as never);

    await expect(controller.getSendLink(id, { user })).resolves.toEqual({ url: 'https://cittadini.notifichedigitali.it/', direct: false });
    expect(sendLegalFacts.getQuickAccessUrl).not.toHaveBeenCalled();
  });

  it('allegato di una notifica SEND rifiutato → nessun download conteggiato', async () => {
    const citizenService = {
      generateAttachmentPdf: jest.fn(async () => { throw new Error('solo su notifichedigitali.it'); }),
      markAsDownloaded: jest.fn(),
    };
    const controller = new CitizenController(citizenService as never, {} as never);
    const res = { setHeader: jest.fn(), end: jest.fn() };

    await expect(controller.downloadAttachment(id, 0, { user }, res as never)).rejects.toThrow();
    expect(citizenService.markAsDownloaded).not.toHaveBeenCalled();
  });
});
