import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PostalStatusSyncService } from './postal-status-sync.service';
import { GlobalComClient } from './globalcom-client.service';
import { PostalProvidersService, type ResolvedPostalProvider } from '../../postal-providers/postal-providers.service';
import { NotificationAttempt } from '../../entities/notification-attempt.entity';

describe('PostalStatusSyncService', () => {
  let service: PostalStatusSyncService;
  let globalCom: jest.Mocked<GlobalComClient>;
  let providers: jest.Mocked<PostalProvidersService>;
  let attemptRepo: { find: jest.Mock; save: jest.Mock; createQueryBuilder: jest.Mock };

  const activeProvider: ResolvedPostalProvider = {
    id: 'provider-1',
    creds: { baseUrl: 'https://esempio.corrispondenzadigitale.it/gbcweb/GBCWebservice.asmx', user: 'u', password: 'p', group: 'g' },
    centroDiCosto: '',
    mittente: null,
    enabledServiceTypes: ['Raccomandata'],
    contratti: [],
  };

  function makeQueryBuilder(rows: any[]) {
    const qb: any = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(rows),
    };
    return qb;
  }

  beforeEach(async () => {
    const mockGlobalCom = { dettagliDocumento: jest.fn(), invioExtSingolo: jest.fn(), cercaPerTesto: jest.fn() };
    const mockProviders = { getActive: jest.fn(async () => activeProvider) };
    attemptRepo = { find: jest.fn(), save: jest.fn(), createQueryBuilder: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        PostalStatusSyncService,
        { provide: GlobalComClient, useValue: mockGlobalCom },
        { provide: PostalProvidersService, useValue: mockProviders },
        { provide: getRepositoryToken(NotificationAttempt), useValue: attemptRepo },
      ],
    }).compile();

    service = module.get(PostalStatusSyncService);
    globalCom = module.get(GlobalComClient) as any;
    providers = module.get(PostalProvidersService) as any;
  });

  it('non fa nulla se non ci sono attempt candidati', async () => {
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([]));

    await service.handleCron();

    expect(globalCom.dettagliDocumento).not.toHaveBeenCalled();
  });

  it('non fa nulla se non c\'è un provider attivo', async () => {
    providers.getActive.mockResolvedValue(null);
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([{ id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: null }]));

    await service.handleCron();

    expect(globalCom.dettagliDocumento).not.toHaveBeenCalled();
  });

  it('aggiorna postalStatus e appende a postalStatusHistory quando lo stato è cambiato', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Accettato', postalStatusUpdatedAt: null, postalStatusHistory: [{ stato: 'Accettato', rilevatoIl: '2026-01-10T10:00:00.000Z' }] };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Consegnato' });

    await service.handleCron();

    expect(globalCom.dettagliDocumento).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: activeProvider.creds.baseUrl }),
      'IDPRO1',
    );
    expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'a1',
      postalStatus: 'Consegnato',
      postalStatusHistory: [
        { stato: 'Accettato', rilevatoIl: '2026-01-10T10:00:00.000Z' },
        { stato: 'Consegnato', rilevatoIl: expect.any(String) },
      ],
    }));
  });

  it('non duplica un elemento in postalStatusHistory se lo stato non è cambiato', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Inviato', postalStatusUpdatedAt: null, postalStatusHistory: [{ stato: 'Inviato', rilevatoIl: '2026-01-10T10:00:00.000Z' }] };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Inviato' });

    await service.handleCron();

    expect(attemptRepo.save).not.toHaveBeenCalled();
    expect(attempt.postalStatusHistory).toEqual([{ stato: 'Inviato', rilevatoIl: '2026-01-10T10:00:00.000Z' }]);
  });

  it('gestisce postalStatusHistory assente (null) su un attempt esistente senza storico pregresso', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Inviato', postalStatusUpdatedAt: null, postalStatusHistory: null };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Consegnato' });

    await service.handleCron();

    expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'a1',
      postalStatusHistory: [{ stato: 'Consegnato', rilevatoIl: expect.any(String) }],
    }));
  });

  it('non salva se lo stato non è cambiato', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Inviato', postalStatusUpdatedAt: null };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Inviato' });

    await service.handleCron();

    expect(attemptRepo.save).not.toHaveBeenCalled();
  });

  it('logga e continua se dettagliDocumento fallisce per un attempt, senza bloccare gli altri', async () => {
    const attempt1 = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Inviato', postalStatusUpdatedAt: null };
    const attempt2 = { id: 'a2', postalTrackingId: 'IDPRO2', postalStatus: 'Inviato', postalStatusUpdatedAt: null };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt1, attempt2]));
    globalCom.dettagliDocumento
      .mockRejectedValueOnce(new Error('timeout SOAP'))
      .mockResolvedValueOnce({ idPro: 'IDPRO2', stato: 'Consegnato' });

    await service.handleCron();

    expect(attemptRepo.save).toHaveBeenCalledTimes(1);
    expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'a2', postalStatus: 'Consegnato' }));
  });
});
