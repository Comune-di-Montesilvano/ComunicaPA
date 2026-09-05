import { Test } from '@nestjs/testing';
import { RegistroImpreseService } from './registro-imprese.service';
import { RegistroImpreseRateLimitError } from './registro-imprese-rate-limit.error';
import { AppSettingsService } from '../../settings/app-settings.service';
import { PdndAuthService } from '../../pdnd/pdnd-auth.service';

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

  it('restituisce found:true e il raw XML quando risponde 200', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: () => Promise.resolve(Buffer.from('<impresa><denominazione>ACME SRL</denominazione></impresa>', 'latin1')),
    });

    const result = await service.dettaglioImpresa('12345678901');

    expect(result.found).toBe(true);
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

  it('lascia pec/denominazione undefined se lo schema atteso non è presente', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: () => Promise.resolve(Buffer.from('<blocchi-impresa/>', 'latin1')) });

    const result = await service.dettaglioImpresa('00000000001');

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
      { nome: 'MARIO', cognome: 'ESEMPIO', cFiscale: 'MRAEXP80A01H501U', dataNascita: '01/01/1980', rappresentante: true, cariche: ['AMMINISTRATORE UNICO'] },
    ]);
    expect(result.data?.localizzazioni).toHaveLength(1);
    expect(result.data?.localizzazioni[0]).toMatchObject({ sottoTipi: ['SEDE OPERATIVA'], attivitaEsercitata: 'CONSULENZA' });
    expect(result.data?.soci).toEqual([{ denominazione: 'SOCIO ESEMPIO S.R.L.', cFiscale: '12345678901', diritto: "PROPRIETA'" }]);
    expect(result.data?.statuto).toMatchObject({ durataSocieta: '31/12/2050', sistemaAmministrazione: 'AMMINISTRATORE UNICO', formeAmministrative: ['AMMINISTRATORE UNICO'] });
    expect(result.data?.patrimonio).toEqual({ valuta: 'EURO', deliberato: '10.000,00', sottoscritto: '10.000,00', versato: '10.000,00' });
  });
});
