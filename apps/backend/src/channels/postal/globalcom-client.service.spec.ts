import { GlobalComClient, mapDocStatus } from './globalcom-client.service';

const mockLoginAsync = jest.fn();
const mockInvioAsync = jest.fn();
const mockListaAsync = jest.fn();
const mockDettagliAsync = jest.fn();
const mockListaRiaccodamentiAsync = jest.fn();
const mockInformazioniUtenzaAsync = jest.fn();
const mockAddHttpHeader = jest.fn();

jest.mock('soap', () => ({
  createClientAsync: jest.fn(async () => ({
    LoginAsync: mockLoginAsync,
    invio_ext_singoloAsync: mockInvioAsync,
    lista_documentiAsync: mockListaAsync,
    dettagli_documentoAsync: mockDettagliAsync,
    lista_riaccodamenti_documentoAsync: mockListaRiaccodamentiAsync,
    InformazioniUtenzaAsync: mockInformazioniUtenzaAsync,
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
      destinatario: { denominazione1: 'Mario Rossi', indirizzo1: 'Via Roma 1', cap: '65015', citta: 'Montesilvano', provincia: 'PE', codiceFiscale: 'RSSMRA85M01H501Z' },
      note: 'attempt-uuid-123',
      fileBuffer: Buffer.from('%PDF-1.4 test'),
    });

    expect(mockLoginAsync).toHaveBeenCalledWith({ user: 'u', password: 'p', group: 'g' });
    expect(mockAddHttpHeader).toHaveBeenCalledWith('Cookie', 'ASP.NET_SessionId=abc123');
    expect(mockInvioAsync).toHaveBeenCalledWith(expect.objectContaining({
      Invio: expect.objectContaining({
        Servizio: 'Raccomandata',
        Nazionale: true,
        RicevutaDiRitorno: true,
        Colore: true,
        FronteRetro: false,
        UsaMittentePredefinito: true,
        UsaDestinatarioARPredefinito: true,
        Note: 'attempt-uuid-123',
        Destinatari: { InfoIndirizzoExt: [expect.objectContaining({ Denominazione1: 'Mario Rossi', Citta: 'Montesilvano', CodiceFiscale: 'RSSMRA85M01H501Z' })] },
      }),
    }));
    expect(result).toEqual(expect.objectContaining({ idPro: 'IDPRO123', stato: 'Accettato', codiceErrore: '', descrizione: '' }));
  });

  it('invioExtSingolo imposta Nazionale=false quando il destinatario ha Stato estero valorizzato', async () => {
    mockInvioAsync.mockResolvedValue([{
      invio_ext_singoloResult: true,
      Risposta: { IDPRO: 'IDPRO-EST', Stato: 'Accettato', CodiceErrore: '', Descrizione: '' },
      Messaggio: '',
    }]);

    await client.invioExtSingolo(creds, {
      servizio: 'RaccomandataMarket4',
      ricevutaDiRitorno: false,
      colore: false,
      fronteRetro: true,
      mittente: null,
      destinatario: { denominazione1: 'Mario Bianchi', indirizzo1: 'Bahnhofplatz 2', citta: 'Kilchberg', stato: 'SVIZZERA' },
      note: 'attempt-uuid-est',
      fileBuffer: Buffer.from('%PDF-1.4 test'),
    });

    expect(mockInvioAsync).toHaveBeenCalledWith(expect.objectContaining({
      Invio: expect.objectContaining({ Nazionale: false }),
    }));
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

  it('invioExtSingolo invia OpzioniAgol/IDCoverPage per Servizio AttoGiudiziario*', async () => {
    mockInvioAsync.mockResolvedValue([{
      invio_ext_singoloResult: true,
      Risposta: { IDPRO: 'IDPRO-AGOL', Stato: 'Accettato', CodiceErrore: '', Descrizione: '' },
      Messaggio: '',
    }]);

    await client.invioExtSingolo(creds, {
      servizio: 'AgolBusiness',
      ricevutaDiRitorno: false,
      colore: false,
      fronteRetro: true,
      mittente: null,
      destinatario: { denominazione1: 'Mario Rossi', indirizzo1: 'Via Roma 1', cap: '65015', citta: 'Montesilvano', provincia: 'PE' },
      note: 'attempt-uuid-agol',
      fileBuffer: Buffer.from('%PDF-1.4 test'),
      idCoverPage: 'COVER123',
      agol: {
        tipoNotificante: 'UfficialeGiudiziario',
        secondoTentativoRecapito: 'Concordato',
        nomeNotificante: 'Mario Bianchi',
        numeroCronologico: '123/2026',
        avvisoRicevimentoDigitale: true,
      },
    });

    const invioArg = (mockInvioAsync.mock.calls[0][0] as { Invio: Record<string, unknown> }).Invio;
    expect(invioArg).toEqual(expect.objectContaining({
      IDCoverPage: 'COVER123',
      OpzioniAgol: {
        TipoNotificante: 'UfficialeGiudiziario',
        SecondoTentativoRecapito: 'Concordato',
        AvvisoRicevimentoDigitale: true,
        NomeNotificante: 'Mario Bianchi',
        NumeroCronologico: '123/2026',
      },
    }));
  });

  it('invioExtSingolo NON imposta OpzioniAgol se params.agol è assente (Servizio non Atto Giudiziario)', async () => {
    mockInvioAsync.mockResolvedValue([{
      invio_ext_singoloResult: true,
      Risposta: { IDPRO: 'IDPRO-NOAGOL', Stato: 'Accettato', CodiceErrore: '', Descrizione: '' },
      Messaggio: '',
    }]);

    await client.invioExtSingolo(creds, {
      servizio: 'Raccomandata',
      ricevutaDiRitorno: false,
      colore: false,
      fronteRetro: true,
      mittente: null,
      destinatario: { denominazione1: 'Mario Rossi', indirizzo1: 'Via Roma 1', cap: '65015', citta: 'Montesilvano', provincia: 'PE' },
      note: 'attempt-uuid-noagol',
      fileBuffer: Buffer.from('%PDF-1.4 test'),
    });

    const invioArg = (mockInvioAsync.mock.calls[0][0] as { Invio: Record<string, unknown> }).Invio;
    expect(invioArg).not.toHaveProperty('OpzioniAgol');
    expect(invioArg).not.toHaveProperty('IDCoverPage');
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

  it('informazioniUtenza legge il flag Estero per ogni contratto (oggi scartato)', async () => {
    mockInformazioniUtenzaAsync.mockResolvedValue([{
      InformazioniUtenzaResult: {
        OperazioneRiuscita: true,
        ProdottiDisponibili: { ServiceType: ['Raccomandata'] },
        ContrattiH2H: {
          DatiContrattoCOLMOLExt: [
            { CodiceContratto: 'C1', Descrizione: 'Contratto Market', Tipologia: 'RaccomandataMarket', Estero: true },
            { CodiceContratto: 'C2', Descrizione: 'Contratto Contest', Tipologia: 'LetteraContest', Estero: false },
          ],
        },
      },
    }]);

    const result = await client.informazioniUtenza(creds);

    expect(result.contratti).toEqual([
      { codiceContratto: 'C1', descrizione: 'Contratto Market', tipologia: 'RaccomandataMarket', estero: true },
      { codiceContratto: 'C2', descrizione: 'Contratto Contest', tipologia: 'LetteraContest', estero: false },
    ]);
  });

  it('informazioniUtenza tratta Estero mancante/undefined come false (contratti legacy pre-fix)', async () => {
    mockInformazioniUtenzaAsync.mockResolvedValue([{
      InformazioniUtenzaResult: {
        OperazioneRiuscita: true,
        ProdottiDisponibili: { ServiceType: ['Raccomandata'] },
        ContrattiH2H: {
          DatiContrattoCOLMOLExt: { CodiceContratto: 'C1', Descrizione: 'D', Tipologia: 'RaccomandataMarket' },
        },
      },
    }]);

    const result = await client.informazioniUtenza(creds);

    expect(result.contratti).toEqual([
      { codiceContratto: 'C1', descrizione: 'D', tipologia: 'RaccomandataMarket', estero: false },
    ]);
  });
  it('listaRiaccodamentiDocumento ritorna solo l\'IDPRO iniziale se non ci sono riaccodamenti', async () => {
    mockListaRiaccodamentiAsync.mockResolvedValue([{
      lista_riaccodamenti_documentoResult: true,
      Risposta: { string: 'IDPRO1' },
    }]);

    const result = await client.listaRiaccodamentiDocumento(creds, 'IDPRO1');

    expect(mockListaRiaccodamentiAsync).toHaveBeenCalledWith({ IDPRO: 'IDPRO1' });
    expect(result).toEqual(['IDPRO1']);
  });

  it('listaRiaccodamentiDocumento ritorna la catena completa ordinata quando ci sono riaccodamenti', async () => {
    mockListaRiaccodamentiAsync.mockResolvedValue([{
      lista_riaccodamenti_documentoResult: true,
      Risposta: { string: ['IDPRO1', 'IDPRO2', 'IDPRO3'] },
    }]);

    const result = await client.listaRiaccodamentiDocumento(creds, 'IDPRO1');

    expect(result).toEqual(['IDPRO1', 'IDPRO2', 'IDPRO3']);
  });

  it('listaRiaccodamentiDocumento ritorna l\'IDPRO passato se lista_riaccodamenti_documentoResult è false', async () => {
    mockListaRiaccodamentiAsync.mockResolvedValue([{
      lista_riaccodamenti_documentoResult: false,
      Risposta: null,
    }]);

    const result = await client.listaRiaccodamentiDocumento(creds, 'IDPRO1');

    expect(result).toEqual(['IDPRO1']);
  });

  it('listaRiaccodamentiDocumento ritorna l\'IDPRO passato se Risposta è presente ma senza campo string (risposta inattesa)', async () => {
    mockListaRiaccodamentiAsync.mockResolvedValue([{
      lista_riaccodamenti_documentoResult: true,
      Risposta: {},
    }]);

    const result = await client.listaRiaccodamentiDocumento(creds, 'IDPRO1');

    expect(result).toEqual(['IDPRO1']);
  });

  it('listaRiaccodamentiDocumento — regressione bug reale: lista_riaccodamenti_documentoResult è un booleano di esito, MAI il wrapper dati (verificato dal vivo su GlobalCom prod)', async () => {
    // Riproduce esattamente la forma reale osservata: il booleano di esito
    // sta in lista_riaccodamenti_documentoResult (stessa convenzione di
    // dettagli_documentoResult), i dati in Risposta.string. La prima
    // versione del metodo leggeva .string dal booleano stesso (undefined,
    // nessun errore) e ricadeva silenziosamente su [idPro] anche con un
    // riaccodamento reale presente — bug mai catturato dai test precedenti
    // perché il mock non rispecchiava la forma reale della risposta.
    mockListaRiaccodamentiAsync.mockResolvedValue([{
      lista_riaccodamenti_documentoResult: true,
      Risposta: { string: ['SOA_238ae93d-afa9-4edf-913b-d1c2f0b867ec', 'SOA_dac5003b-8088-459e-bf98-3d341e597739'] },
      Messaggio: '',
    }]);

    const result = await client.listaRiaccodamentiDocumento(creds, 'SOA_238ae93d-afa9-4edf-913b-d1c2f0b867ec');

    expect(result).toEqual(['SOA_238ae93d-afa9-4edf-913b-d1c2f0b867ec', 'SOA_dac5003b-8088-459e-bf98-3d341e597739']);
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

  it('estrae campi consegna (StatoConsegna, CodiceConsegna, DataConsegna, IDAccettazione) da StatoDestinatari', () => {
    const raw = {
      IDPRO: 'SOA_123',
      Stato: 'Confermato',
      CodiceErrore: '0',
      Descrizione: '',
      StatoDestinatari: {
        GBCDestStatus: {
          StatoConsegna: 'Consegnato',
          CodiceConsegna: 100,
          DataConsegna: '2026-07-28T14:30:00.000Z',
          IDAccettazione: 'ACC123456',
        },
      },
    };

    const result = mapDocStatus(raw);

    expect(result.statoConsegna).toBe('Consegnato');
    expect(result.codiceConsegna).toBe(100);
    expect(result.dataConsegna).toBe('2026-07-28T14:30:00.000Z');
    expect(result.idAccettazione).toBe('ACC123456');
  });

  it('gestisce GBCDestStatus come array (più destinatari)', () => {
    const raw = {
      IDPRO: 'SOA_123',
      Stato: 'Confermato',
      StatoDestinatari: {
        GBCDestStatus: [
          { StatoConsegna: 'In lavorazione', CodiceConsegna: 10 },
          { StatoConsegna: 'Consegnato', CodiceConsegna: 100, DataConsegna: '2026-07-28T14:30:00.000Z', IDAccettazione: 'ACC999' },
        ],
      },
    };

    const result = mapDocStatus(raw);

    expect(result.statoConsegna).toBe('In lavorazione');
    expect(result.codiceConsegna).toBe(10);
  });
});
