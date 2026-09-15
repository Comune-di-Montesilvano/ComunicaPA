import { Test } from '@nestjs/testing';
import { DomicilioService } from './domicilio.service.js';
import { InadService } from '../inad/inad.service.js';
import { IoServicesService } from '../../io-services/io-services.service.js';
import { AnprService } from '../anpr/anpr.service.js';
import { RegistroImpreseService } from '../registro-imprese/registro-imprese.service.js';

const mockInad = { extractDigitalAddress: jest.fn() };
const mockIoServices = { verifyProfile: jest.fn() };
const mockAnpr = { getResidenza: jest.fn(), getEsistenzaInVita: jest.fn(), getGeneralitaByAnagrafica: jest.fn() };
const mockRegistroImpreseUnused = { dettaglioImpresa: jest.fn(), ricercaDenominazione: jest.fn() };

describe('DomicilioService.cercaDomicilio', () => {
  let service: DomicilioService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        DomicilioService,
        { provide: InadService, useValue: mockInad },
        { provide: IoServicesService, useValue: mockIoServices },
        { provide: AnprService, useValue: mockAnpr },
        { provide: RegistroImpreseService, useValue: mockRegistroImpreseUnused },
      ],
    }).compile();
    service = module.get(DomicilioService);
  });

  it('combina i tre esiti quando tutte e tre le fonti rispondono correttamente', async () => {
    mockInad.extractDigitalAddress.mockResolvedValue({ found: true, data: { codiceFiscale: 'CF1', since: '2020', digitalAddress: [] } });
    mockIoServices.verifyProfile.mockResolvedValue({ success: true, active: true, message: 'ok' });
    mockAnpr.getResidenza.mockResolvedValue({
      found: true,
      data: { generalita: { cognome: 'Rossi' }, residenza: [], infoSoggettoEnte: [{ chiave: 'ESISTENZA_IN_VITA', valore: 'S' }] },
    });

    const result = await service.cercaDomicilio('CF1', 'mario.rossi');

    expect(result.codiceFiscale).toBe('CF1');
    expect(result.inad).toEqual({ success: true, found: true, digitalAddress: [] });
    expect(result.appIo).toEqual({ success: true, active: true, message: 'ok' });
    expect(result.anpr).toEqual({
      success: true,
      found: true,
      generalita: { cognome: 'Rossi' },
      residenza: [],
      infoSoggettoEnte: [{ chiave: 'ESISTENZA_IN_VITA', valore: 'S' }],
    });
    expect(mockAnpr.getResidenza).toHaveBeenCalledWith('CF1', 'mario.rossi');
  });

  it('un fallimento di una fonte non impedisce la risposta delle altre due', async () => {
    mockInad.extractDigitalAddress.mockRejectedValue(new Error('INAD giù'));
    mockIoServices.verifyProfile.mockResolvedValue({ success: true, active: false, message: 'non attivo' });
    mockAnpr.getResidenza.mockResolvedValue({ found: false });

    const result = await service.cercaDomicilio('CF1', 'mario.rossi');

    expect(result.inad).toEqual({ success: false, found: false, message: 'INAD giù' });
    expect(result.appIo).toEqual({ success: true, active: false, message: 'non attivo' });
    expect(result.anpr).toEqual({ success: true, found: false });
  });

  it('chiama C019 e include la data decesso quando C002 segnala il soggetto deceduto', async () => {
    mockInad.extractDigitalAddress.mockResolvedValue({ found: false });
    mockIoServices.verifyProfile.mockResolvedValue({ success: true, active: false, message: 'non attivo' });
    mockAnpr.getResidenza.mockResolvedValue({
      found: true,
      data: { generalita: { cognome: 'Bianchi' }, residenza: [], infoSoggettoEnte: [{ chiave: 'Verifica esistenza in vita', valore: 'N' }] },
    });
    mockAnpr.getEsistenzaInVita.mockResolvedValue({
      found: true,
      data: { generalita: { cognome: 'Bianchi' }, esistenzaInVita: 'N', dataDecesso: '2026-01-15' },
    });

    const result = await service.cercaDomicilio('CF1', 'mario.rossi');

    expect(mockAnpr.getEsistenzaInVita).toHaveBeenCalledWith('CF1', 'mario.rossi');
    expect(result.anprEsistenzaInVita).toEqual({ success: true, dataDecesso: '2026-01-15' });
  });

  it('non chiama C019 quando il soggetto risulta in vita', async () => {
    mockInad.extractDigitalAddress.mockResolvedValue({ found: false });
    mockIoServices.verifyProfile.mockResolvedValue({ success: true, active: false, message: 'non attivo' });
    mockAnpr.getResidenza.mockResolvedValue({
      found: true,
      data: { generalita: { cognome: 'Rossi' }, residenza: [], infoSoggettoEnte: [{ chiave: 'Verifica esistenza in vita', valore: 'S' }] },
    });

    const result = await service.cercaDomicilio('CF1', 'mario.rossi');

    expect(mockAnpr.getEsistenzaInVita).not.toHaveBeenCalled();
    expect(result.anprEsistenzaInVita).toBeUndefined();
  });

  it('include un messaggio di errore esplicito se C019 fallisce', async () => {
    mockInad.extractDigitalAddress.mockResolvedValue({ found: false });
    mockIoServices.verifyProfile.mockResolvedValue({ success: true, active: false, message: 'non attivo' });
    mockAnpr.getResidenza.mockResolvedValue({
      found: true,
      data: { generalita: { cognome: 'Bianchi' }, residenza: [], infoSoggettoEnte: [{ chiave: 'Verifica esistenza in vita', valore: 'N' }] },
    });
    mockAnpr.getEsistenzaInVita.mockRejectedValue(new Error('Configurazione ANPR C019 incompleta: purposeId non impostato'));

    const result = await service.cercaDomicilio('CF1', 'mario.rossi');

    expect(result.anprEsistenzaInVita).toEqual({ success: false, message: 'Configurazione ANPR C019 incompleta: purposeId non impostato' });
  });
});

describe('DomicilioService.cercaPerAnagrafica', () => {
  let service: DomicilioService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        DomicilioService,
        { provide: InadService, useValue: mockInad },
        { provide: IoServicesService, useValue: mockIoServices },
        { provide: AnprService, useValue: mockAnpr },
        { provide: RegistroImpreseService, useValue: mockRegistroImpreseUnused },
      ],
    }).compile();
    service = module.get(DomicilioService);
  });

  const criteri = { cognome: "D'Addiego", nome: 'Mirko', sesso: 'M', dataNascita: '1988-09-06', comuneNascita: 'Vasto', provinciaNascita: 'CH' };

  it('inoltra criteri/operatore/motivoRichiesta a AnprService e restituisce found:true con generalità', async () => {
    mockAnpr.getGeneralitaByAnagrafica.mockResolvedValue({
      found: true,
      data: { idANPR: 'DO56003EY', generalita: { codiceFiscale: { codFiscale: 'DDDMRK88P06E372L' } }, residenza: [], infoSoggettoEnte: [] },
    });

    const result = await service.cercaPerAnagrafica(criteri, 'mario.rossi', 'pratica-esproprio-123');

    expect(mockAnpr.getGeneralitaByAnagrafica).toHaveBeenCalledWith(criteri, 'mario.rossi', 'pratica-esproprio-123');
    expect(result).toEqual({
      success: true,
      found: true,
      idANPR: 'DO56003EY',
      generalita: { codiceFiscale: { codFiscale: 'DDDMRK88P06E372L' } },
      residenza: [],
      infoSoggettoEnte: [],
    });
  });

  it('restituisce found:false senza eccezione quando ANPR non trova corrispondenza', async () => {
    mockAnpr.getGeneralitaByAnagrafica.mockResolvedValue({ found: false });

    const result = await service.cercaPerAnagrafica(criteri, 'mario.rossi', 'pratica-x');

    expect(result).toEqual({ success: true, found: false, idANPR: undefined, generalita: undefined, residenza: undefined, infoSoggettoEnte: undefined });
  });

  it('cattura errore (es. 400 EN148 per criteri mancanti) e lo espone come message, non propaga eccezione', async () => {
    mockAnpr.getGeneralitaByAnagrafica.mockRejectedValue(new Error('ANPR C002 fallito: HTTP 400 — Indicare il sesso'));

    const result = await service.cercaPerAnagrafica(criteri, 'mario.rossi', 'pratica-x');

    expect(result).toEqual({ success: false, found: false, message: 'ANPR C002 fallito: HTTP 400 — Indicare il sesso' });
  });
});

describe('DomicilioService.cercaDomicilio — Partita IVA', () => {
  let service: DomicilioService;
  const mockRegistroImprese = { dettaglioImpresa: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        DomicilioService,
        { provide: InadService, useValue: mockInad },
        { provide: IoServicesService, useValue: mockIoServices },
        { provide: AnprService, useValue: mockAnpr },
        { provide: RegistroImpreseService, useValue: mockRegistroImprese },
      ],
    }).compile();
    service = module.get(DomicilioService);
  });

  it('per una Partita IVA interroga solo Registro Imprese, non ANPR/INAD/AppIO', async () => {
    mockRegistroImprese.dettaglioImpresa.mockResolvedValue({ found: true, raw: '<xml/>', pec: 'acme@pec.it', denominazione: 'ACME SRL' });

    const result = await service.cercaDomicilio('12345678901', 'mario.rossi');

    expect(result.codiceFiscale).toBe('12345678901');
    expect(result.registroImprese).toEqual({ success: true, found: true, pec: 'acme@pec.it', denominazione: 'ACME SRL' });
    expect(result.inad).toBeUndefined();
    expect(result.appIo).toBeUndefined();
    expect(result.anpr).toBeUndefined();
    expect(mockInad.extractDigitalAddress).not.toHaveBeenCalled();
    expect(mockIoServices.verifyProfile).not.toHaveBeenCalled();
    expect(mockAnpr.getResidenza).not.toHaveBeenCalled();
  });

  it('gestisce un fallimento di Registro Imprese senza propagare eccezione', async () => {
    mockRegistroImprese.dettaglioImpresa.mockRejectedValue(new Error('Registro Imprese: limite richieste superato'));

    const result = await service.cercaDomicilio('12345678901', 'mario.rossi');

    expect(result.registroImprese).toEqual({ success: false, found: false, message: 'Registro Imprese: limite richieste superato' });
  });

  it('con forzaImpresa=true interroga Registro Imprese anche per un CF in formato persona fisica (impresa individuale)', async () => {
    mockRegistroImprese.dettaglioImpresa.mockResolvedValue({ found: true, raw: '<xml/>', pec: 'rossi@pec.it', denominazione: 'ROSSI MARIO' });

    const result = await service.cercaDomicilio('RSSMRA80A01H501U', 'mario.rossi', true);

    expect(result.registroImprese).toEqual({ success: true, found: true, pec: 'rossi@pec.it', denominazione: 'ROSSI MARIO' });
    expect(result.inad).toBeUndefined();
    expect(mockInad.extractDigitalAddress).not.toHaveBeenCalled();
    expect(mockRegistroImprese.dettaglioImpresa).toHaveBeenCalledWith('RSSMRA80A01H501U');
  });

  it('senza forzaImpresa un CF persona fisica prosegue sul ramo ANPR/INAD/AppIO (default false)', async () => {
    mockInad.extractDigitalAddress.mockResolvedValue({ found: false });
    mockIoServices.verifyProfile.mockResolvedValue({ success: true, active: false, message: 'non attivo' });
    mockAnpr.getResidenza.mockResolvedValue({ found: false });

    const result = await service.cercaDomicilio('RSSMRA80A01H501U', 'mario.rossi');

    expect(result.registroImprese).toBeUndefined();
    expect(mockRegistroImprese.dettaglioImpresa).not.toHaveBeenCalled();
  });
});

describe('DomicilioService.cercaPerDenominazione', () => {
  let service: DomicilioService;
  const mockRegistroImprese = { dettaglioImpresa: jest.fn(), ricercaDenominazione: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        DomicilioService,
        { provide: InadService, useValue: mockInad },
        { provide: IoServicesService, useValue: mockIoServices },
        { provide: AnprService, useValue: mockAnpr },
        { provide: RegistroImpreseService, useValue: mockRegistroImprese },
      ],
    }).compile();
    service = module.get(DomicilioService);
  });

  it('inoltra denominazione/siglaProvincia e restituisce le posizioni trovate', async () => {
    const posizioni = [{ denominazione: 'ACME SRL', cFiscale: '00000000001', pec: 'acme@pec.it' }];
    mockRegistroImprese.ricercaDenominazione.mockResolvedValue({ raw: '<xml/>', posizioni });

    const result = await service.cercaPerDenominazione('ACME', 'PE');

    expect(mockRegistroImprese.ricercaDenominazione).toHaveBeenCalledWith('ACME', 'PE');
    expect(result).toEqual({ success: true, posizioni });
  });

  it('cattura un errore (es. 429) e lo espone come message, non propaga eccezione', async () => {
    mockRegistroImprese.ricercaDenominazione.mockRejectedValue(new Error('Registro Imprese: limite richieste superato'));

    const result = await service.cercaPerDenominazione('ACME', undefined);

    expect(result).toEqual({ success: false, posizioni: [], message: 'Registro Imprese: limite richieste superato' });
  });
});
