import { GlobalComClient } from './globalcom-client.service';

const mockLoginAsync = jest.fn();
const mockInvioAsync = jest.fn();
const mockListaAsync = jest.fn();
const mockDettagliAsync = jest.fn();
const mockAddHttpHeader = jest.fn();

jest.mock('soap', () => ({
  createClientAsync: jest.fn(async () => ({
    LoginAsync: mockLoginAsync,
    invio_ext_singoloAsync: mockInvioAsync,
    lista_documentiAsync: mockListaAsync,
    dettagli_documentoAsync: mockDettagliAsync,
    addHttpHeader: mockAddHttpHeader,
    lastResponseHeaders: { 'set-cookie': ['ASP.NET_SessionId=abc123; path=/'] },
  })),
}));

describe('GlobalComClient', () => {
  let client: GlobalComClient;
  const creds = { baseUrl: 'https://esempio.corrispondenzadigitale.it/gbcweb/GBCWebservice.asmx', user: 'u', password: 'p', group: 'g' };

  beforeEach(() => {
    jest.clearAllMocks();
    client = new GlobalComClient();
    mockLoginAsync.mockResolvedValue([{ LoginResult: true, message: '' }]);
  });

  it('invioExtSingolo effettua login, apre sessione via cookie e invia il documento', async () => {
    mockInvioAsync.mockResolvedValue([{
      Result: true,
      Risposta: { IDPRO: 'IDPRO123', Stato: 'Accettato', CodiceErrore: '', Descrizione: '' },
      Messaggio: '',
    }]);

    const result = await client.invioExtSingolo(creds, {
      servizio: 'Raccomandata',
      ricevutaDiRitorno: true,
      mittente: null,
      destinatario: { denominazione1: 'Mario Rossi', indirizzo1: 'Via Roma 1', cap: '65015', citta: 'Montesilvano', provincia: 'PE' },
      note: 'attempt-uuid-123',
      fileBuffer: Buffer.from('%PDF-1.4 test'),
    });

    expect(mockLoginAsync).toHaveBeenCalledWith({ user: 'u', password: 'p', group: 'g' });
    expect(mockAddHttpHeader).toHaveBeenCalledWith('Cookie', 'ASP.NET_SessionId=abc123');
    expect(mockInvioAsync).toHaveBeenCalledWith(expect.objectContaining({
      Invio: expect.objectContaining({
        Servizio: 'Raccomandata',
        RicevutaDiRitorno: true,
        UsaMittentePredefinito: true,
        Note: 'attempt-uuid-123',
        Destinatari: [expect.objectContaining({ Denominazione1: 'Mario Rossi', Citta: 'Montesilvano' })],
      }),
    }));
    expect(result).toEqual({ idPro: 'IDPRO123', stato: 'Accettato', codiceErrore: '', descrizione: '' });
  });

  it('invioExtSingolo lancia se Login fallisce', async () => {
    mockLoginAsync.mockResolvedValue([{ LoginResult: false, message: 'credenziali errate' }]);

    await expect(client.invioExtSingolo(creds, {
      servizio: 'Lettera',
      ricevutaDiRitorno: false,
      mittente: null,
      destinatario: { denominazione1: 'X', indirizzo1: 'Y', citta: 'Z' },
      note: 'n',
      fileBuffer: Buffer.from('x'),
    })).rejects.toThrow('Login GlobalCom fallito: credenziali errate');
  });

  it('invioExtSingolo lancia se il risultato non è Result=true', async () => {
    mockInvioAsync.mockResolvedValue([{ Result: false, Risposta: null, Messaggio: 'errore generico' }]);

    await expect(client.invioExtSingolo(creds, {
      servizio: 'Lettera',
      ricevutaDiRitorno: false,
      mittente: null,
      destinatario: { denominazione1: 'X', indirizzo1: 'Y', citta: 'Z' },
      note: 'n',
      fileBuffer: Buffer.from('x'),
    })).rejects.toThrow('invio_ext_singolo fallito: errore generico');
  });

  it('cercaPerTesto interroga lista_documenti con SoloTesto', async () => {
    mockListaAsync.mockResolvedValue([{
      Risposta: [{ IDPRO: 'IDPRO999', Stato: 'Consegnato', CodiceErrore: '', Descrizione: '' }],
      Messaggio: '',
    }]);

    const result = await client.cercaPerTesto(creds, 'attempt-uuid-123');

    expect(mockListaAsync).toHaveBeenCalledWith({
      Filtri: { Testo: 'attempt-uuid-123', SoloTesto: true, Limite: 1 },
    });
    expect(result).toEqual([{ idPro: 'IDPRO999', stato: 'Consegnato', codiceErrore: '', descrizione: '' }]);
  });

  it('dettagliDocumento ritorna null se il documento non è trovato', async () => {
    mockDettagliAsync.mockResolvedValue([{ Result: true, Risposta: null, Messaggio: '' }]);

    const result = await client.dettagliDocumento(creds, 'IDPRO000');

    expect(result).toBeNull();
  });

  it('dettagliDocumento ritorna lo stato quando il documento esiste', async () => {
    mockDettagliAsync.mockResolvedValue([{
      Result: true,
      Risposta: { IDPRO: 'IDPRO000', Stato: 'Consegnato', CodiceErrore: '', Descrizione: '' },
      Messaggio: '',
    }]);

    const result = await client.dettagliDocumento(creds, 'IDPRO000');

    expect(result).toEqual({ idPro: 'IDPRO000', stato: 'Consegnato', codiceErrore: '', descrizione: '' });
  });
});
