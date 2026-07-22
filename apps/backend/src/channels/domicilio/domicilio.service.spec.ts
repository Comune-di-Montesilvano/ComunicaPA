import { Test } from '@nestjs/testing';
import { DomicilioService } from './domicilio.service';
import { InadService } from '../inad/inad.service';
import { IoServicesService } from '../../io-services/io-services.service';
import { AnprService } from '../anpr/anpr.service';

const mockInad = { extractDigitalAddress: jest.fn() };
const mockIoServices = { verifyProfile: jest.fn() };
const mockAnpr = { getResidenza: jest.fn(), getEsistenzaInVita: jest.fn() };

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
