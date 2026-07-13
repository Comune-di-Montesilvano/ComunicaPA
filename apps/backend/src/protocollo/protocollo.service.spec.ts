import { Test } from '@nestjs/testing';
import { ProtocolloService } from './protocollo.service';
import { AppSettingsService } from '../settings/app-settings.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const settingsValues: Record<string, unknown> = {
  'protocollo.baseUrl': 'https://proto.test.local/',
  'protocollo.codiceEnte': '0000000000',
  'protocollo.username': 'OPERATORE_WS',
  'protocollo.password': 'segreta',
  'protocollo.codiceTitolario': '6022',
  'protocollo.codiceAmministrazione': '1',
  'protocollo.unitaOrganizzativa': '1',
  'protocollo.mittenteDenominazione': 'Comune di Prova',
};
const mockSettings = { get: jest.fn(async (key: string) => settingsValues[key]) };

function soapEnvelope(body: string) {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${body}</soap:Body></soap:Envelope>`;
}

describe('ProtocolloService', () => {
  let service: ProtocolloService;

  beforeEach(async () => {
    mockFetch.mockClear();
    const module = await Test.createTestingModule({
      providers: [
        ProtocolloService,
        { provide: AppSettingsService, useValue: mockSettings },
      ],
    }).compile();
    service = module.get(ProtocolloService);
  });

  it('esegue il login e ritorna il DST', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(soapEnvelope(
        '<LoginResponse><return><strDST>dst-token-123</strDST><IngErrNumber>0</IngErrNumber><strErrString></strErrString></return></LoginResponse>',
      )),
    });

    const dst = await service.login();
    expect(dst).toBe('dst-token-123');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://proto.test.local/');
    expect(init.method).toBe('POST');
    expect(init.body).toContain('0000000000');
    expect(init.body).toContain('OPERATORE_WS');
    expect(init.body).toContain('segreta');
  });

  it('riusa il DST in cache finché non forzato', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(soapEnvelope(
        '<LoginResponse><return><strDST>dst-1</strDST><IngErrNumber>0</IngErrNumber><strErrString></strErrString></return></LoginResponse>',
      )),
    });
    await service.login();
    await service.login();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rifà login se forceRefresh è true', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(soapEnvelope(
        '<LoginResponse><return><strDST>dst-1</strDST><IngErrNumber>0</IngErrNumber><strErrString></strErrString></return></LoginResponse>',
      )),
    });
    await service.login();
    await service.login(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('lancia errore leggibile se il servizio risponde IngErrNumber != 0', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(soapEnvelope(
        '<LoginResponse><return><strDST></strDST><IngErrNumber>5</IngErrNumber><strErrString>Credenziali non valide</strErrString></return></LoginResponse>',
      )),
    });
    await expect(service.login()).rejects.toThrow(/Login Protocollo fallito.*Credenziali non valide/);
  });
});
