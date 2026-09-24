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
