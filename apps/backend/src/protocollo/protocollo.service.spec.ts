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

  it('esegue Inserimento + Protocollazione e ritorna numero/anno/data', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(soapEnvelope(
          '<LoginResponse><return><strDST>dst-abc</strDST><IngErrNumber>0</IngErrNumber><strErrString></strErrString></return></LoginResponse>',
        )),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(soapEnvelope(
          '<InserimentoResponse><return><IngDocID>999</IngDocID><IngErrNumber>0</IngErrNumber><strErrString></strErrString></return></InserimentoResponse>',
        )),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(soapEnvelope(
          '<ProtocollazioneResponse><return><IngNumPG>4321</IngNumPG><IngAnnoPG>2026</IngAnnoPG><StrDataPG>13/07/2026</StrDataPG><IngErrNumber>0</IngErrNumber><strErrString></strErrString></return></ProtocollazioneResponse>',
        )),
      });

    const result = await service.protocolla({
      oggetto: 'Avviso TARI 2026',
      destinatario: { codiceFiscale: 'RSSMRA85M01H501Z', nome: 'Mario', cognome: 'Rossi', denominazione: 'Mario Rossi' },
      documentBuffer: Buffer.from('%PDF-1.4 test'),
      documentFilename: 'avviso.pdf',
    });

    expect(result).toEqual({ numeroProtocollo: 4321, annoProtocollo: 2026, dataProtocollazione: '13/07/2026' });
    expect(mockFetch).toHaveBeenCalledTimes(3);

    const inserimentoBody = mockFetch.mock.calls[1][1].body as string;
    expect(inserimentoBody).toContain('dst-abc');

    const protocollazioneBody = mockFetch.mock.calls[2][1].body as string;
    const fileXmlMatch = protocollazioneBody.match(/<FileXML>([\s\S]*?)<\/FileXML>/);
    const segnaturaXml = Buffer.from(fileXmlMatch![1], 'base64').toString('utf-8');
    expect(segnaturaXml).toContain('RSSMRA85M01H501Z');
    expect(segnaturaXml).toContain('<Flusso>U</Flusso>');
    expect(segnaturaXml).toContain('id="999"');
  });

  it('lancia errore leggibile se Protocollazione fallisce', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(soapEnvelope(
          '<LoginResponse><return><strDST>dst-abc</strDST><IngErrNumber>0</IngErrNumber><strErrString></strErrString></return></LoginResponse>',
        )),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(soapEnvelope(
          '<InserimentoResponse><return><IngDocID>999</IngDocID><IngErrNumber>0</IngErrNumber><strErrString></strErrString></return></InserimentoResponse>',
        )),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(soapEnvelope(
          '<ProtocollazioneResponse><return><IngNumPG>0</IngNumPG><IngAnnoPG>0</IngAnnoPG><StrDataPG></StrDataPG><IngErrNumber>7</IngErrNumber><strErrString>Classifica non valida</strErrString></return></ProtocollazioneResponse>',
        )),
      });

    await expect(service.protocolla({
      oggetto: 'Test',
      destinatario: { codiceFiscale: 'CF', nome: 'N', cognome: 'C', denominazione: 'N C' },
      documentBuffer: Buffer.from('x'),
      documentFilename: 'x.pdf',
    })).rejects.toThrow(/Protocollazione fallita.*Classifica non valida/);
  });
});
