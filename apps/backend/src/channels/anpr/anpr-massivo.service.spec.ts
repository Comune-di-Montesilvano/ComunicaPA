import { Test } from '@nestjs/testing';
import { gunzipSync, gzipSync } from 'node:zlib';
import { AnprMassivoService, parseRispostaMassiva } from './anpr-massivo.service.js';
import { AppSettingsService } from '../../settings/app-settings.service.js';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service.js';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'anpr.massivoId.purposeId': 'purpose-id',
  'anpr.massivoVita.purposeId': 'purpose-vita',
  'anpr.trackingUserLocation': 'comunicapa-backend',
  'anpr.trackingLoA': 'SpidL2',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };
const mockPdndAuth = {
  getVoucherWithDigest: jest.fn(async () => 'voucher-abc'),
  signAgidJwt: jest.fn(async (_env: string, _aud: string, claims: Record<string, unknown>) =>
    claims['userID'] ? 'jws-tracking' : 'jws-signature',
  ),
};

const esito = {
  risposteMassive: [
    { cf: 'RSSMRA80A01H501U', RispostaE002OK: { listaSoggetti: { datiSoggetto: [{ identificativi: { idANPR: 'AB12345CD' } }] }, idOperazioneANPR: '1' } },
    { cf: 'VRDLGI80A01H501E', RispostaE002OK: { listaSoggetti: { datiSoggetto: [] } } },
  ],
};

const esitoVita = {
  risposteMassive: [
    { cf: 'RSSMRA80A01H501U', RispostaE002OK: { listaSoggetti: { datiSoggetto: [{ infoSoggettoEnte: [{ id: '1003', chiave: 'Verifica esistenza in vita', valore: 'S' }] }] }, idOperazioneANPR: '0' } },
    { cf: 'RSSMRA85M01H501Q', RispostaE002OK: { listaSoggetti: { datiSoggetto: [{ infoSoggettoEnte: [{ id: '1003', chiave: 'Verifica esistenza in vita', valore: 'N' }] }] }, idOperazioneANPR: '1' } },
  ],
};

describe('parseRispostaMassiva', () => {
  it('legge gzip binario, base64 di gzip e JSON in chiaro', () => {
    const json = Buffer.from(JSON.stringify(esito));
    const gz = gzipSync(json);
    for (const buf of [gz, Buffer.from(gz.toString('base64')), json]) {
      expect([...parseRispostaMassiva(buf).keys()]).toEqual(['RSSMRA80A01H501U']);
    }
  });

  it('C007: legge "Verifica esistenza in vita" S/N per CF', () => {
    const esiti = parseRispostaMassiva(Buffer.from(JSON.stringify(esitoVita)));
    expect(esiti.get('RSSMRA80A01H501U')).toEqual({ esistenzaInVita: 'S' });
    expect(esiti.get('RSSMRA85M01H501Q')).toEqual({ esistenzaInVita: 'N' });
  });

  it('voce senza soggetti = non presente', () => {
    expect(parseRispostaMassiva(Buffer.from(JSON.stringify(esito))).has('VRDLGI80A01H501E')).toBe(false);
  });

  it('esito illeggibile o senza risposteMassive → eccezione (mai "nessuno presente")', () => {
    expect(() => parseRispostaMassiva(Buffer.from('<html>errore</html>'))).toThrow();
    expect(() => parseRispostaMassiva(Buffer.from('{}'))).toThrow();
  });
});

describe('AnprMassivoService', () => {
  let service: AnprMassivoService;

  beforeEach(async () => {
    mockFetch.mockReset();
    mockPdndAuth.signAgidJwt.mockClear();
    mockPdndAuth.getVoucherWithDigest.mockClear();
    const module = await Test.createTestingModule({
      providers: [
        AnprMassivoService,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
      ],
    }).compile();
    service = module.get(AnprMassivoService);
  });

  it('richiesta: file gzip base64 con un CF per riga, caso d\'uso C030, tipoRicerca 1, restituisce idOperazioneANPR', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{"idOperazioneANPR":987,"stato":0}') });

    const id = await service.start('id', ['RSSMRA80A01H501U', 'VRDLGI80A01H501E'], 'verifica-domicili-x', 'mario');

    expect(id).toBe('987');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toMatch(/E002AccertamentoIdAnprMassivo\/v1\/anpr-massivo-e002-richiesta$/);
    const body = JSON.parse(init.body);
    expect(body.tipoRicerca).toBe('1');
    expect(body.datiRichiesta).toMatchObject({ casoUso: 'C030', motivoRichiesta: 'verifica-domicili-x' });
    expect(body.idOperazioneClient.length).toBeLessThanOrEqual(30);
    expect(gunzipSync(Buffer.from(body.fileInput, 'base64')).toString()).toBe('RSSMRA80A01H501U\nVRDLGI80A01H501E\n');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer voucher-abc', 'Agid-JWT-TrackingEvidence': 'jws-tracking', 'Agid-JWT-Signature': 'jws-signature' });
    expect(init.headers.Digest).toMatch(/^SHA-256=/);
    expect(mockPdndAuth.getVoucherWithDigest).toHaveBeenCalledWith('prod', 'purpose-id', expect.any(String));
  });

  it('richiesta C007: path esistenza in vita, caso d\'uso C007, purposeId dedicato', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{"idOperazioneANPR":5}') });

    await service.start('vita', ['RSSMRA80A01H501U'], 'x', 'mario');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toMatch(/E002VericaEsistenzaInVitaMassiva\/v1\/anpr-massivo-e002-richiesta$/);
    expect(JSON.parse(init.body).datiRichiesta.casoUso).toBe('C007');
    expect(mockPdndAuth.getVoucherWithDigest).toHaveBeenCalledWith('prod', 'purpose-vita', expect.any(String));
  });

  it('richiesta rifiutata → eccezione con HTTP e corpo', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve('{"listaErrori":[]}') });
    await expect(service.start('id', ['RSSMRA80A01H501U'], 'x', 'mario')).rejects.toThrow(/HTTP 400/);
  });

  it('download non pronto (404) → ready:false con dettaglio; 200 → CF presenti', async () => {
    mockFetch.mockResolvedValueOnce({ status: 404, arrayBuffer: () => Promise.resolve(Buffer.from('non trovata')) });
    expect(await service.download('id', '987', 'mario')).toEqual({ ready: false, detail: 'HTTP 404: non trovata' });

    const gz = gzipSync(Buffer.from(JSON.stringify(esito)));
    mockFetch.mockResolvedValueOnce({ status: 200, arrayBuffer: () => Promise.resolve(gz) });
    const res = await service.download('id', '987', 'mario');
    expect(res.ready && [...res.esiti.keys()]).toEqual(['RSSMRA80A01H501U']);
    expect(mockFetch.mock.calls[1][0]).toMatch(/anpr-massivo-e002-download\/resource\/987$/);
  });

  it('download 401 → eccezione (configurazione), mai "non pronto"', async () => {
    mockFetch.mockResolvedValue({ status: 401, arrayBuffer: () => Promise.resolve(Buffer.from('no')) });
    await expect(service.download('id', '987', 'mario')).rejects.toThrow(/HTTP 401/);
  });
});
