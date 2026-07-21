import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { AnprService } from './anpr.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'anpr.prod.purposeId': 'purpose-anpr-prod',
  'anpr.trackingUserLocation': 'comunicapa-backend',
  'anpr.trackingLoA': 'https://www.spid.gov.it/SpidL2',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };
const mockPdndAuth = {
  getVoucherWithDigest: jest.fn(async () => 'voucher-abc'),
  signAgidJwt: jest.fn(async (_env: string, _aud: string, extraClaims: Record<string, unknown>) =>
    extraClaims['userID'] ? 'jws-token-tracking' : 'jws-token-signature',
  ),
};

describe('AnprService.getResidenza', () => {
  let service: AnprService;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockPdndAuth.getVoucherWithDigest.mockClear();
    mockPdndAuth.signAgidJwt.mockClear();
    const module = await Test.createTestingModule({
      providers: [
        AnprService,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
      ],
    }).compile();
    service = module.get(AnprService);
  });

  it('restituisce found:true e i dati quando ANPR risponde 200 con un soggetto', async () => {
    const body = {
      idOperazioneANPR: 'op-1',
      listaSoggetti: {
        datiSoggetto: [
          {
            generalita: { codiceFiscale: { codFiscale: 'RRANGL74M28R701V' }, cognome: 'Rossi', nome: 'Angela', dataNascita: '1974-08-28' },
            residenza: [{ tipoIndirizzo: '1', indirizzo: { cap: '65015', comune: { nomeComune: 'Montesilvano' } }, dataDecorrenzaResidenza: '2020-01-01' }],
            identificativi: { idANPR: 'ANPR-123' },
            infoSoggettoEnte: [{ chiave: 'ESISTENZA_IN_VITA', valore: 'S' }],
          },
        ],
      },
    };
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });

    const result = await service.getResidenza('RRANGL74M28R701V', 'mario.rossi');

    expect(result.found).toBe(true);
    expect(result.data?.idANPR).toBe('ANPR-123');
    expect(result.data?.generalita.cognome).toBe('Rossi');
    expect(result.data?.residenza[0].indirizzo?.comune?.nomeComune).toBe('Montesilvano');
    expect(result.data?.infoSoggettoEnte).toEqual([{ chiave: 'ESISTENZA_IN_VITA', valore: 'S' }]);

    expect(mockPdndAuth.signAgidJwt).toHaveBeenCalledTimes(2);

    // Ordine: prima la TrackingEvidence (serve il suo digest per il voucher), poi la Signature.
    const trackingCallArgs = mockPdndAuth.signAgidJwt.mock.calls[0];
    expect(trackingCallArgs[1]).toBe(
      'https://modipa.anpr.interno.it/govway/rest/in/MinInternoPortaANPR/C002-servizioComunicazione/v1',
    );
    expect(trackingCallArgs[2]).toEqual(
      expect.objectContaining({ userID: 'mario.rossi', userLocation: 'comunicapa-backend', LoA: 'https://www.spid.gov.it/SpidL2' }),
    );

    const expectedTrackingDigest = createHash('sha256').update('jws-token-tracking').digest('hex');
    expect(mockPdndAuth.getVoucherWithDigest).toHaveBeenCalledWith('prod', 'purpose-anpr-prod', expectedTrackingDigest);

    const signatureCallArgs = mockPdndAuth.signAgidJwt.mock.calls[1];
    expect(signatureCallArgs[1]).toBe(
      'https://modipa.anpr.interno.it/govway/rest/in/MinInternoPortaANPR/C002-servizioComunicazione/v1',
    );
    expect(signatureCallArgs[2]).toEqual(
      expect.objectContaining({ signed_headers: [{ digest: expect.stringMatching(/^SHA-256=/) }, { 'Content-Type': 'application/json' }] }),
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://modipa.anpr.interno.it/govway/rest/in/MinInternoPortaANPR-PDND/C002-servizioComunicazione/v1/anpr-service-e002',
    );
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer voucher-abc');
    expect(init.headers.DPoP).toBeUndefined();
    expect(init.headers['Agid-JWT-Signature']).toBe('jws-token-signature');
    expect(init.headers['Agid-JWT-TrackingEvidence']).toBe('jws-token-tracking');
    expect(init.headers.Digest).toMatch(/^SHA-256=/);

    const sentBody = JSON.parse(init.body);
    expect(sentBody.criteriRicerca).toEqual({ codiceFiscale: 'RRANGL74M28R701V' });
    expect(sentBody.datiRichiesta.casoUso).toBe('C002');
    expect(sentBody.datiRichiesta.motivoRichiesta).toBe('comunicapa-cerca-domicilio');
  });

  it('restituisce found:false quando ANPR risponde 404 (posizione non presente)', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('{"listaErrori":[]}') });

    const result = await service.getResidenza('RRANGL74M28R701V', 'mario.rossi');

    expect(result).toEqual({ found: false });
  });

  it('restituisce found:false quando ANPR risponde 200 senza soggetti in lista', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{"idOperazioneANPR":"op-1","listaSoggetti":{"datiSoggetto":[]}}') });

    const result = await service.getResidenza('RRANGL74M28R701V', 'mario.rossi');

    expect(result).toEqual({ found: false });
  });

  it('lancia errore leggibile su altri status HTTP', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve('{"listaErrori":[{"testoErroreAnomalia":"bad request"}]}') });

    await expect(service.getResidenza('RRANGL74M28R701V', 'mario.rossi')).rejects.toThrow(/ANPR C002 fallito: HTTP 400/);
  });

  it('propaga l\'errore se il purposeId prod non è configurato', async () => {
    mockSettings.get.mockResolvedValueOnce(undefined);
    await expect(service.getResidenza('RRANGL74M28R701V', 'mario.rossi')).rejects.toThrow();
  });
});
