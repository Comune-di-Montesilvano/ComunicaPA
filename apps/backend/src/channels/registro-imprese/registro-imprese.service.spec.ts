import { Test } from '@nestjs/testing';
import { RegistroImpreseService } from './registro-imprese.service.js';
import { RegistroImpreseRateLimitError } from './registro-imprese-rate-limit.error.js';
import { AppSettingsService } from '../../settings/app-settings.service.js';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service.js';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const mockSettings = { get: jest.fn(async (key: string) => (key === 'registroImprese.prod.purposeId' ? 'purpose-ri-prod' : undefined)) };
const mockPdndAuth = { getVoucher: jest.fn(async () => 'voucher-abc') };

describe('RegistroImpreseService.dettaglioImpresa', () => {
  let service: RegistroImpreseService;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockPdndAuth.getVoucher.mockClear();
    const module = await Test.createTestingModule({
      providers: [
        RegistroImpreseService,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
      ],
    }).compile();
    service = module.get(RegistroImpreseService);
  });

  it('restituisce found:false e il raw XML quando risponde 200 ma senza schema/denominazione riconoscibile (mai "trovato" su un HTTP 200 vuoto)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: () => Promise.resolve(Buffer.from('<impresa><denominazione>ACME SRL</denominazione></impresa>', 'latin1')),
    });

    const result = await service.dettaglioImpresa('12345678901');

    // Bug reale (E2E su dati prod): found era hardcoded true su ogni 200,
    // anche senza denominazione riconosciuta — 449/2096 CF fisici segnati
    // "trovati" su Registro Imprese, impossibile per persone fisiche.
    expect(result.found).toBe(false);
    expect(result.raw).toBe('<impresa><denominazione>ACME SRL</denominazione></impresa>');
    expect(result.denominazione).toBeUndefined();
    expect(mockPdndAuth.getVoucher).toHaveBeenCalledWith('prod', 'purpose-ri-prod');
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://pdnd.registroimprese.it/rest/pcad/v1/dettaglio/codicefiscale?codiceFiscale=12345678901');
    expect(init.headers.Authorization).toBe('Bearer voucher-abc');
  });

  it('restituisce found:false su 404', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(Buffer.from('', 'latin1')) });

    const result = await service.dettaglioImpresa('12345678901');

    expect(result).toEqual({ found: false, raw: '' });
  });

  it('lancia RegistroImpreseRateLimitError su 429 con Retry-After', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (h: string) => (h === 'Retry-After' ? '30' : null) },
      arrayBuffer: () => Promise.resolve(Buffer.from('limite superato', 'latin1')),
    });

    await expect(service.dettaglioImpresa('12345678901')).rejects.toThrow(RegistroImpreseRateLimitError);
    try {
      await service.dettaglioImpresa('12345678901');
    } catch (err) {
      expect((err as RegistroImpreseRateLimitError).retryAfterSeconds).toBe(30);
    }
  });

  it('lancia errore leggibile su altri status HTTP', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(Buffer.from('non abilitato', 'latin1')) });

    await expect(service.dettaglioImpresa('12345678901')).rejects.toThrow(/Registro Imprese dettaglio fallito: HTTP 401/);
  });

  it('propaga errore se il purposeId non è configurato', async () => {
    mockSettings.get.mockResolvedValueOnce(undefined);
    await expect(service.dettaglioImpresa('12345678901')).rejects.toThrow(/purposeId non impostato/);
  });

  it('estrae pec/denominazione dallo schema reale (dati-identificativi + indirizzo-posta-certificata)', async () => {
    // Forma confermata con chiamata reale (2026-09-05) — dati qui fittizi,
    // vedi CLAUDE.md "No PII reale nel codice".
    const xml =
      '<?xml version="1.0" encoding="windows-1252"?>' +
      '<blocchi-impresa>' +
      '<dati-identificativi c-fonte="RI" fonte="Registro Imprese" denominazione="ROSSI ESEMPIO S.R.L." c-fiscale="00000000001" partita-iva="00000000001" cciaa="PE" n-rea="1">' +
      '<forma-giuridica c="SR">SOCIETA\' A RESPONSABILITA\' LIMITATA</forma-giuridica>' +
      '<indirizzo-posta-certificata>ESEMPIO@PEC.IT</indirizzo-posta-certificata>' +
      '</dati-identificativi>' +
      '</blocchi-impresa>';
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(Buffer.from(xml, 'latin1')) });

    const result = await service.dettaglioImpresa('00000000001');

    expect(result.found).toBe(true);
    expect(result.denominazione).toBe('ROSSI ESEMPIO S.R.L.');
    expect(result.pec).toBe('esempio@pec.it');
  });

  it('impresa cessata da più di un anno: found:true (impresa esiste) ma pec:undefined (non usabile)', async () => {
    // Caso reale (impresa cancellata 2015, PEC ancora presente nel
    // dettaglio ma quasi certamente disattivata) — dati qui fittizi.
    const xml =
      '<?xml version="1.0" encoding="windows-1252"?>' +
      '<blocchi-impresa>' +
      '<dati-identificativi denominazione="ROSSI ESEMPIO IMPRESA INDIVIDUALE" c-fiscale="00000000001" partita-iva="00000000001" cciaa="PE" n-rea="1" stato-impresa="CANCELLATA" dt-cancellazione="09/03/2015" causale-cess="CESSAZIONE DI OGNI ATTIVITA\'">' +
      '<indirizzo-posta-certificata>ESEMPIO@PEC.IT</indirizzo-posta-certificata>' +
      '</dati-identificativi>' +
      '</blocchi-impresa>';
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(Buffer.from(xml, 'latin1')) });

    const result = await service.dettaglioImpresa('00000000001');

    expect(result.found).toBe(true);
    expect(result.denominazione).toBe('ROSSI ESEMPIO IMPRESA INDIVIDUALE');
    expect(result.pec).toBeUndefined();
    // Il dato grezzo resta comunque disponibile in .data per la UI "Cerca Domicilio"
    expect(result.data?.sede.pec).toBe('esempio@pec.it');
  });

  it('impresa cessata da meno di un anno: pec resta valida', async () => {
    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
    const dd = String(oneMonthAgo.getDate()).padStart(2, '0');
    const mm = String(oneMonthAgo.getMonth() + 1).padStart(2, '0');
    const yyyy = oneMonthAgo.getFullYear();
    const xml =
      '<?xml version="1.0" encoding="windows-1252"?>' +
      '<blocchi-impresa>' +
      `<dati-identificativi denominazione="ROSSI ESEMPIO IMPRESA INDIVIDUALE" c-fiscale="00000000001" partita-iva="00000000001" cciaa="PE" n-rea="1" stato-impresa="CANCELLATA" dt-cancellazione="${dd}/${mm}/${yyyy}">` +
      '<indirizzo-posta-certificata>ESEMPIO@PEC.IT</indirizzo-posta-certificata>' +
      '</dati-identificativi>' +
      '</blocchi-impresa>';
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(Buffer.from(xml, 'latin1')) });

    const result = await service.dettaglioImpresa('00000000001');

    expect(result.found).toBe(true);
    expect(result.pec).toBe('esempio@pec.it');
  });

  it('impresa cessata senza data di cancellazione nota: conservativo, pec non usabile', async () => {
    const xml =
      '<?xml version="1.0" encoding="windows-1252"?>' +
      '<blocchi-impresa>' +
      '<dati-identificativi denominazione="ROSSI ESEMPIO IMPRESA INDIVIDUALE" c-fiscale="00000000001" partita-iva="00000000001" cciaa="PE" n-rea="1" stato-impresa="CANCELLATA">' +
      '<indirizzo-posta-certificata>ESEMPIO@PEC.IT</indirizzo-posta-certificata>' +
      '</dati-identificativi>' +
      '</blocchi-impresa>';
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(Buffer.from(xml, 'latin1')) });

    const result = await service.dettaglioImpresa('00000000001');

    expect(result.found).toBe(true);
    expect(result.pec).toBeUndefined();
  });

  it('found:false su risposta reale "nessuna impresa" (200 con <blocchi-impresa/> vuoto, mai 404 su questo endpoint)', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(Buffer.from('<blocchi-impresa/>', 'latin1')) });

    const result = await service.dettaglioImpresa('00000000001');

    expect(result.found).toBe(false);
    expect(result.denominazione).toBeUndefined();
    expect(result.pec).toBeUndefined();
  });

  it('estrae la struttura completa (persone, localizzazioni, soci, statuto, patrimonio) — dati fittizi', async () => {
    const xml = `<?xml version="1.0" encoding="windows-1252"?>
<blocchi-impresa>
<dati-identificativi denominazione="ROSSI ESEMPIO S.R.L." c-fiscale="00000000001" partita-iva="00000000001" cciaa="PE" n-rea="1" dt-iscrizione-ri="01/01/2000" dt-atto-costituzione="01/01/2000">
<forma-giuridica c="SR">SOCIETA' A RESPONSABILITA' LIMITATA</forma-giuridica>
<indirizzo-localizzazione comune="PESCARA" provincia="PE" toponimo="VIA" via="ESEMPIO" n-civico="1" cap="65100"/>
<indirizzo-posta-certificata>ESEMPIO@PEC.IT</indirizzo-posta-certificata>
</dati-identificativi>
<info-attivita>
<attivita-esercitata>COMMERCIO AL DETTAGLIO</attivita-esercitata>
<attivita-prevalente>DAL 2000: COMMERCIO</attivita-prevalente>
<classificazioni-ateco>
<classificazione-ateco c-attivita="46.50.10" attivita="Commercio all'ingrosso" c-importanza="P"/>
<classificazione-ateco c-attivita="62.10.00" attivita="Programmazione informatica" c-importanza="S"/>
</classificazioni-ateco>
</info-attivita>
<persone-sede>
<persona f-rappresentante-ri="S">
<persona-fisica cognome="ESEMPIO" nome="MARIO" c-fiscale="MRAEXP80A01H501U">
<estremi-nascita dt="01/01/1980"/></persona-fisica>
<atti-conferimento-cariche>
<atto-conferimento-cariche><cariche><carica c-carica="AU">AMMINISTRATORE UNICO</carica></cariche></atto-conferimento-cariche>
</atti-conferimento-cariche></persona>
</persone-sede>
<localizzazioni>
<localizzazione tipo="UNITA' LOCALE" dt-apertura="01/01/2020">
<sotto-tipi><sotto-tipo>SEDE OPERATIVA</sotto-tipo></sotto-tipi>
<indirizzo-localizzazione comune="ROMA" provincia="RM" via="ESEMPIO" n-civico="10" cap="00100"/>
<attivita-esercitata>CONSULENZA</attivita-esercitata>
<classificazioni-ateco><classificazione-ateco c-attivita="62.10.00" attivita="Programmazione" c-importanza="P"/></classificazioni-ateco>
</localizzazione>
</localizzazioni>
<elenco-soci><riquadri><riquadro><titolari>
<titolare><anagrafica-titolare c-fiscale="12345678901" denominazione="SOCIO ESEMPIO S.R.L."/><diritto-partecipazione tipo="PROPRIETA'"/></titolare>
</titolari></riquadro></riquadri></elenco-soci>
<info-statuto><durata-societa dt-termine="31/12/2050"/></info-statuto>
<amministrazione-controllo>
<sistema-amministrazione>AMMINISTRATORE UNICO</sistema-amministrazione>
<forme-amministrative><forma-amministrativa>AMMINISTRATORE UNICO</forma-amministrativa></forme-amministrative>
<collegio-sindacale n-effettivi="0" n-supplenti="0"/>
</amministrazione-controllo>
<info-patrimoniali-finanziarie><capitale-sociale valuta="EURO">
<deliberato ammontare="10.000,00"/><sottoscritto ammontare="10.000,00"/><versato ammontare="10.000,00"/>
</capitale-sociale></info-patrimoniali-finanziarie>
</blocchi-impresa>`;
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(Buffer.from(xml, 'latin1')) });

    const result = await service.dettaglioImpresa('00000000001');

    expect(result.data?.sede).toMatchObject({
      denominazione: 'ROSSI ESEMPIO S.R.L.',
      formaGiuridica: "SOCIETA' A RESPONSABILITA' LIMITATA",
      partitaIva: '00000000001',
      pec: 'esempio@pec.it',
      indirizzo: { comune: 'PESCARA', provincia: 'PE', via: 'ESEMPIO', cap: '65100' },
    });
    expect(result.data?.attivita.ateco).toHaveLength(2);
    expect(result.data?.persone).toEqual([
      { nome: 'MARIO', cognome: 'ESEMPIO', cFiscale: 'MRAEXP80A01H501U', dataNascita: '01/01/1980', rappresentante: true, cariche: ['AMMINISTRATORE UNICO'], poteri: [] },
    ]);
    expect(result.data?.localizzazioni).toHaveLength(1);
    expect(result.data?.localizzazioni[0]).toMatchObject({ sottoTipi: ['SEDE OPERATIVA'], attivitaEsercitata: 'CONSULENZA' });
    expect(result.data?.soci).toEqual([{ denominazione: 'SOCIO ESEMPIO S.R.L.', cFiscale: '12345678901', diritto: "PROPRIETA'" }]);
    expect(result.data?.statuto).toMatchObject({ durataSocieta: '31/12/2050', sistemaAmministrazione: 'AMMINISTRATORE UNICO', formeAmministrative: ['AMMINISTRATORE UNICO'] });
    expect(result.data?.patrimonio).toEqual({ valuta: 'EURO', deliberato: '10.000,00', sottoscritto: '10.000,00', versato: '10.000,00' });
  });

  it('estrae stato-impresa/dt-cancellazione/causale-cess per un\'impresa cessata (dati fittizi)', async () => {
    // Forma confermata con chiamata reale (2026-09-15, CF cessato reale) — dati qui fittizi.
    const xml =
      '<?xml version="1.0" encoding="windows-1252"?>' +
      '<blocchi-impresa>' +
      '<dati-identificativi denominazione="ROSSI ESEMPIO S.A.S." c-fiscale="00000000001" partita-iva="00000000001" cciaa="PE" n-rea="1" ' +
      'stato-impresa="CANCELLATA" dt-cancellazione="21/02/2019" c-causale-cess="SC" causale-cess="SCIOGLIMENTO">' +
      '<forma-giuridica c="AS">SOCIETA\' IN ACCOMANDITA SEMPLICE</forma-giuridica>' +
      '</dati-identificativi>' +
      '</blocchi-impresa>';
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(Buffer.from(xml, 'latin1')) });

    const result = await service.dettaglioImpresa('00000000001');

    expect(result.data?.sede).toMatchObject({
      statoImpresa: 'CANCELLATA',
      dtCancellazione: '21/02/2019',
      causaleCessazione: 'SCIOGLIMENTO',
    });
  });

  it('estrae valore-nominale-conferimenti per società di persone, non capitale-sociale (dati fittizi)', async () => {
    // Forma confermata con chiamata reale (2026-09-15, CF SAS reale) — dati qui fittizi.
    const xml =
      '<?xml version="1.0" encoding="windows-1252"?>' +
      '<blocchi-impresa>' +
      '<dati-identificativi denominazione="ROSSI ESEMPIO S.A.S." c-fiscale="00000000001" partita-iva="00000000001" cciaa="PE" n-rea="1"/>' +
      '<info-patrimoniali-finanziarie><valore-nominale-conferimenti c-valuta="EU" valuta="EURO" ammontare="6.500,00"/></info-patrimoniali-finanziarie>' +
      '</blocchi-impresa>';
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(Buffer.from(xml, 'latin1')) });

    const result = await service.dettaglioImpresa('00000000001');

    expect(result.data?.patrimonio).toBeUndefined();
    expect(result.data?.valoreNominaleConferimenti).toEqual({ valuta: 'EURO', ammontare: '6.500,00' });
  });

  it('estrae dt-iscrizione-rea come fallback quando dt-iscrizione-ri è assente, fonte/tipo-soggetto/tipo-impresa, dt-inizio-attivita-impresa, poteri-persona e soggetto-controllo-contabile per una SPA (dati fittizi)', async () => {
    // Forma confermata con chiamata reale (2026-09-15, CF SPA reale) — dati qui fittizi.
    const xml = `<?xml version="1.0" encoding="windows-1252"?>
<blocchi-impresa>
<dati-identificativi c-fonte="RI" fonte="Registro Imprese" tipo-soggetto="I" descrizione-tipo-soggetto="Sede dell'impresa" tipo-impresa="SC" descrizione-tipo-impresa="Societa' di capitale" dt-iscrizione-rea="21/06/1960" denominazione="ROSSI ESEMPIO S.P.A." c-fiscale="00000000001" partita-iva="00000000001" cciaa="PE" n-rea="1">
<forma-giuridica c="SP">SOCIETA' PER AZIONI</forma-giuridica>
</dati-identificativi>
<info-attivita dt-inizio-attivita-impresa="10/12/2009">
<attivita-esercitata>COMMERCIO</attivita-esercitata>
</info-attivita>
<persone-sede>
<persona f-rappresentante-ri="S">
<persona-fisica cognome="ESEMPIO" nome="MARIO" c-fiscale="MRAEXP80A01H501U">
<estremi-nascita dt="01/01/1980"/></persona-fisica>
<atti-conferimento-cariche>
<atto-conferimento-cariche>
<cariche><carica c-carica="PCA">PRESIDENTE CONSIGLIO AMMINISTRAZIONE</carica></cariche>
<poteri-persona p-poteri="14">RAPPRESENTANZA LEGALE DELLA SOCIETA' IN GIUDIZIO.</poteri-persona>
</atto-conferimento-cariche>
</atti-conferimento-cariche></persona>
</persone-sede>
<info-statuto>
<durata-societa dt-termine="31/12/2050" c-tipo-proroga="SI" tipo-proroga="PROROGA TACITA" n-anni-proroga-tacita="5">
<scadenza-esercizi dt-primo-esercizio="31/12/2009"/></durata-societa></info-statuto>
<amministrazione-controllo>
<soggetto-controllo-contabile c="S">SOCIETA' DI REVISIONE</soggetto-controllo-contabile>
</amministrazione-controllo>
</blocchi-impresa>`;
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(Buffer.from(xml, 'latin1')) });

    const result = await service.dettaglioImpresa('00000000001');

    expect(result.data?.sede).toMatchObject({
      dtIscrizioneRi: '21/06/1960',
      fonte: 'Registro Imprese',
      descrizioneTipoSoggetto: "Sede dell'impresa",
      descrizioneTipoImpresa: "Societa' di capitale",
    });
    expect(result.data?.attivita.dtInizioAttivitaImpresa).toBe('10/12/2009');
    expect(result.data?.persone[0].poteri).toEqual(["RAPPRESENTANZA LEGALE DELLA SOCIETA' IN GIUDIZIO."]);
    expect(result.data?.statuto).toMatchObject({
      tipoProroga: 'PROROGA TACITA',
      nAnniProrogaTacita: '5',
      dtPrimoEsercizio: '31/12/2009',
      soggettoControlloContabile: "SOCIETA' DI REVISIONE",
    });
  });
});

describe('RegistroImpreseService.ricercaDenominazione', () => {
  let service: RegistroImpreseService;

  beforeEach(async () => {
    mockFetch.mockClear();
    mockPdndAuth.getVoucher.mockClear();
    const module = await Test.createTestingModule({
      providers: [
        RegistroImpreseService,
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: PdndAuthService, useValue: mockPdndAuth },
      ],
    }).compile();
    service = module.get(RegistroImpreseService);
  });

  it('passa denominazione e siglaProvincia come query param', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(Buffer.from('<ListaImpreseRI xmlns="http://it.registroimprese.pcad.ws"/>', 'latin1')) });

    await service.ricercaDenominazione('ACME', 'PE');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://pdnd.registroimprese.it/rest/pcad/v1/ricerca/denominazione?denominazione=ACME&siglaProvincia=PE');
  });

  it('omette siglaProvincia quando non fornita', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(Buffer.from('<ListaImpreseRI xmlns="http://it.registroimprese.pcad.ws"/>', 'latin1')) });

    await service.ricercaDenominazione('ACME', undefined);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('https://pdnd.registroimprese.it/rest/pcad/v1/ricerca/denominazione?denominazione=ACME');
  });

  it('parsa più occorrenze — schema confermato dal vivo (2026-09-15), dati fittizi', async () => {
    const xml =
      '<?xml version="1.0" encoding="ISO-8859-1"?>' +
      '<ListaImpreseRI xmlns="http://it.registroimprese.pcad.ws">' +
      '<Impresa>' +
      '<ProgressivoImpresa>1</ProgressivoImpresa>' +
      '<Cciaa>PE</Cciaa><NRea>1</NRea>' +
      '<Denominazione>ACME ESEMPIO SRL</Denominazione>' +
      '<NaturaGiuridica>SR</NaturaGiuridica>' +
      '<DescNaturaGiuridica>SOCIETA\' A RESPONSABILITA\' LIMITATA</DescNaturaGiuridica>' +
      '<CodiceFiscale>00000000001</CodiceFiscale>' +
      '<StatoImpresa>Registrata</StatoImpresa>' +
      '<IndirizzoSedeLegale>' +
      '<ProvinciaSede>PE</ProvinciaSede><ComuneSede>PESCARA</ComuneSede>' +
      '<ToponimoSede>VIA</ToponimoSede><ViaSede>ESEMPIO</ViaSede>' +
      '<NcivicoSede>1</NcivicoSede><CapSede>65100</CapSede>' +
      '</IndirizzoSedeLegale>' +
      '<PEC>ACME@PEC.IT</PEC>' +
      '</Impresa>' +
      '<Impresa>' +
      '<ProgressivoImpresa>2</ProgressivoImpresa>' +
      '<Cciaa>PE</Cciaa><NRea>2</NRea>' +
      '<Denominazione>ACME BIS SRL</Denominazione>' +
      '<CodiceFiscale>00000000002</CodiceFiscale>' +
      '</Impresa>' +
      '</ListaImpreseRI>';
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(Buffer.from(xml, 'latin1')) });

    const result = await service.ricercaDenominazione('ACME', 'PE');

    expect(result.posizioni).toHaveLength(2);
    expect(result.posizioni[0]).toMatchObject({
      denominazione: 'ACME ESEMPIO SRL',
      formaGiuridica: "SOCIETA' A RESPONSABILITA' LIMITATA",
      cFiscale: '00000000001',
      pec: 'acme@pec.it',
      cciaa: 'PE',
      nRea: '1',
      statoImpresa: 'Registrata',
      indirizzo: { comune: 'PESCARA', provincia: 'PE', via: 'ESEMPIO', cap: '65100' },
    });
    expect(result.posizioni[1]).toMatchObject({ denominazione: 'ACME BIS SRL', cFiscale: '00000000002' });
  });

  it('restituisce lista vuota quando nessuna impresa corrisponde (root senza figli)', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(Buffer.from('<ListaImpreseRI xmlns="http://it.registroimprese.pcad.ws"/>', 'latin1')) });

    const result = await service.ricercaDenominazione('INESISTENTE', undefined);

    expect(result.posizioni).toEqual([]);
  });

  it('lancia RegistroImpreseRateLimitError su 429', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429, headers: { get: (h: string) => (h === 'Retry-After' ? '15' : null) }, arrayBuffer: () => Promise.resolve(Buffer.from('', 'latin1')) });

    await expect(service.ricercaDenominazione('ACME', undefined)).rejects.toThrow(RegistroImpreseRateLimitError);
  });

  it('lancia errore leggibile su altri status HTTP', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(Buffer.from('denominazione troppo corta', 'latin1')) });

    await expect(service.ricercaDenominazione('A', undefined)).rejects.toThrow(/Registro Imprese ricerca fallita: HTTP 400/);
  });
});
