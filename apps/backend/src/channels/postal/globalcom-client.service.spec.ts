import { GlobalComClient, mapDocStatus } from './globalcom-client.service';

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
      invio_ext_singoloResult: true,
      Risposta: { IDPRO: 'IDPRO123', Stato: 'Accettato', CodiceErrore: '', Descrizione: '' },
      Messaggio: '',
    }]);

    const result = await client.invioExtSingolo(creds, {
      servizio: 'Raccomandata',
      ricevutaDiRitorno: true,
      colore: true,
      fronteRetro: false,
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
        Colore: true,
        FronteRetro: false,
        UsaMittentePredefinito: true,
        UsaDestinatarioARPredefinito: true,
        Note: 'attempt-uuid-123',
        Destinatari: { InfoIndirizzoExt: [expect.objectContaining({ Denominazione1: 'Mario Rossi', Citta: 'Montesilvano' })] },
      }),
    }));
    expect(result).toEqual(expect.objectContaining({ idPro: 'IDPRO123', stato: 'Accettato', codiceErrore: '', descrizione: '' }));
  });

  it('invioExtSingolo invia Ricevuta esplicita se params.ricevuta è impostato (AR), niente UsaDestinatarioARPredefinito', async () => {
    mockInvioAsync.mockResolvedValue([{
      invio_ext_singoloResult: true,
      Risposta: { IDPRO: 'IDPRO789', Stato: 'Accettato', CodiceErrore: '', Descrizione: '' },
      Messaggio: '',
    }]);

    await client.invioExtSingolo(creds, {
      servizio: 'RaccomandataMarket4',
      ricevutaDiRitorno: true,
      colore: false,
      fronteRetro: true,
      mittente: { denominazione1: 'Comune di Montesilvano', indirizzo1: 'Piazza Diaz 1', cap: '65015', citta: 'Montesilvano', provincia: 'PE' },
      ricevuta: { denominazione1: 'Comune di Montesilvano', indirizzo1: 'Piazza Diaz 1', cap: '65015', citta: 'Montesilvano', provincia: 'PE' },
      destinatario: { denominazione1: 'Mario Rossi', indirizzo1: 'Via Roma 1', cap: '65015', citta: 'Montesilvano', provincia: 'PE' },
      note: 'attempt-uuid-789',
      fileBuffer: Buffer.from('%PDF-1.4 test'),
    });

    const invioArg = (mockInvioAsync.mock.calls[0][0] as { Invio: Record<string, unknown> }).Invio;
    expect(invioArg).toEqual(expect.objectContaining({
      Ricevuta: expect.objectContaining({ Denominazione1: 'Comune di Montesilvano' }),
    }));
    expect(invioArg).not.toHaveProperty('UsaDestinatarioARPredefinito');
  });

  it('invioExtSingolo NON imposta UsaDestinatarioARPredefinito se ricevutaDiRitorno=false', async () => {
    mockInvioAsync.mockResolvedValue([{
      invio_ext_singoloResult: true,
      Risposta: { IDPRO: 'IDPRO456', Stato: 'Accettato', CodiceErrore: '', Descrizione: '' },
      Messaggio: '',
    }]);

    await client.invioExtSingolo(creds, {
      servizio: 'Raccomandata',
      ricevutaDiRitorno: false,
      colore: false,
      fronteRetro: true,
      mittente: null,
      destinatario: { denominazione1: 'Mario Rossi', indirizzo1: 'Via Roma 1', cap: '65015', citta: 'Montesilvano', provincia: 'PE' },
      note: 'attempt-uuid-456',
      fileBuffer: Buffer.from('%PDF-1.4 test'),
    });

    const invioArg = (mockInvioAsync.mock.calls[0][0] as { Invio: Record<string, unknown> }).Invio;
    expect(invioArg).not.toHaveProperty('UsaDestinatarioARPredefinito');
  });

  it('invioExtSingolo lancia se Login fallisce', async () => {
    mockLoginAsync.mockResolvedValue([{ LoginResult: false, message: 'credenziali errate' }]);

    await expect(client.invioExtSingolo(creds, {
      servizio: 'Lettera',
      ricevutaDiRitorno: false,
      colore: false,
      fronteRetro: true,
      mittente: null,
      destinatario: { denominazione1: 'X', indirizzo1: 'Y', citta: 'Z' },
      note: 'n',
      fileBuffer: Buffer.from('x'),
    })).rejects.toThrow('Login GlobalCom fallito: credenziali errate');
  });

  it('invioExtSingolo lancia se il risultato non è invio_ext_singoloResult=true', async () => {
    mockInvioAsync.mockResolvedValue([{ invio_ext_singoloResult: false, Risposta: null, Messaggio: 'errore generico' }]);

    await expect(client.invioExtSingolo(creds, {
      servizio: 'Lettera',
      ricevutaDiRitorno: false,
      colore: false,
      fronteRetro: true,
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
    expect(result).toEqual([expect.objectContaining({ idPro: 'IDPRO999', stato: 'Consegnato', codiceErrore: '', descrizione: '' })]);
  });

  it('dettagliDocumento ritorna null se il documento non è trovato', async () => {
    mockDettagliAsync.mockResolvedValue([{ dettagli_documentoResult: true, Risposta: null, Messaggio: '' }]);

    const result = await client.dettagliDocumento(creds, 'IDPRO000');

    expect(result).toBeNull();
  });

  it('dettagliDocumento ritorna lo stato quando il documento esiste', async () => {
    mockDettagliAsync.mockResolvedValue([{
      dettagli_documentoResult: true,
      Risposta: { IDPRO: 'IDPRO000', Stato: 'Consegnato', CodiceErrore: '', Descrizione: '' },
      Messaggio: '',
    }]);

    const result = await client.dettagliDocumento(creds, 'IDPRO000');

    expect(result).toEqual(expect.objectContaining({ idPro: 'IDPRO000', stato: 'Consegnato', codiceErrore: '', descrizione: '' }));
  });
});

describe('mapDocStatus — campi costo', () => {
  it('estrae Costo/NumeroPagine/Nazionale/DettaglioBilling dalla risposta Risposta.Valori', () => {
    const raw = {
      IDPRO: 'SOA_123',
      Stato: 'Confermato',
      CodiceErrore: '0',
      Descrizione: '',
      TipoDocumento: 'RaccomandataMarket4',
      CodiceContratto: '40009679559',
      Nazionale: true,
      Valori: {
        Costo: 4.31,
        NumeroPagine: 2,
        DettaglioBilling: {
          ImportoPostaleNetto: 4.03,
          ImportoStampaNetto: 0.28,
          ImportoARNetto: 0,
        },
      },
    };

    const result = mapDocStatus(raw);

    expect(result.costoNetto).toBe(4.31);
    expect(result.numeroPagine).toBe(2);
    expect(result.nazionale).toBe(true);
    expect(result.importoPostaleNetto).toBe(4.03);
    expect(result.importoStampaNetto).toBe(0.28);
    expect(result.importoARNetto).toBe(0);
    expect(result.tipoDocumento).toBe('RaccomandataMarket4');
    expect(result.codiceContratto).toBe('40009679559');
  });

  it('gestisce Valori assente (risposta di errore) senza lanciare', () => {
    const raw = { IDPRO: 'SOA_123', Stato: 'Errore', CodiceErrore: '99', Descrizione: 'fallito' };

    const result = mapDocStatus(raw);

    expect(result.costoNetto).toBeNull();
    expect(result.numeroPagine).toBeNull();
    expect(result.nazionale).toBeNull();
  });
});
