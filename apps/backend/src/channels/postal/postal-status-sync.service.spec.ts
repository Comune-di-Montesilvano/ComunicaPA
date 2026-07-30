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
  let attemptRepo: { find: jest.Mock; findOne: jest.Mock; findOneBy: jest.Mock; create: jest.Mock; save: jest.Mock; createQueryBuilder: jest.Mock };

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
    const mockGlobalCom = { dettagliDocumento: jest.fn(), invioExtSingolo: jest.fn(), cercaPerTesto: jest.fn(), listaRiaccodamentiDocumento: jest.fn() };
    const mockProviders = { getActive: jest.fn(async () => activeProvider) };
    attemptRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      create: jest.fn((partial) => partial),
      save: jest.fn(async (entity) => entity),
      createQueryBuilder: jest.fn(),
    };

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
    globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Consegnato' } as any);

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

  it('persiste codiceErrore/descrizione nella entry di postalStatusHistory quando presenti', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Accettato', postalStatusUpdatedAt: null, postalStatusHistory: [] };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({
      idPro: 'IDPRO1',
      stato: 'Errore',
      codiceErrore: '-1',
      descrizione: 'numeri raccomandata non salvati o non disponibili',
    } as any);

    await service.handleCron();

    expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      postalStatusHistory: [
        {
          stato: 'Errore',
          rilevatoIl: expect.any(String),
          codiceErrore: '-1',
          descrizione: 'numeri raccomandata non salvati o non disponibili',
        },
      ],
    }));
  });

  it('non persiste codiceErrore benigno "0" (es. su stato Confermato, esito positivo)', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Accettato', postalStatusUpdatedAt: null, postalStatusHistory: [] };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({
      idPro: 'IDPRO1',
      stato: 'Confermato',
      codiceErrore: '0',
    } as any);

    await service.handleCron();

    expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      postalStatusHistory: [
        { stato: 'Confermato', rilevatoIl: expect.any(String) },
      ],
    }));
  });

  it('persiste codiceErrore/descrizione reali anche su stato non terminale (es. Rimandato, in attesa di retry lato GlobalCom)', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Accettato', postalStatusUpdatedAt: null, postalStatusHistory: [] };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({
      idPro: 'IDPRO1',
      stato: 'Rimandato',
      codiceErrore: '-2',
      descrizione: "Richiesta HTTP vietata con lo schema di autenticazione client 'Basic'",
    } as any);

    await service.handleCron();

    expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      postalStatusHistory: [
        {
          stato: 'Rimandato',
          rilevatoIl: expect.any(String),
          codiceErrore: '-2',
          descrizione: "Richiesta HTTP vietata con lo schema di autenticazione client 'Basic'",
        },
      ],
    }));
  });

  it('non duplica un elemento in postalStatusHistory se lo stato non è cambiato', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Inviato', postalStatusUpdatedAt: null, postalStatusHistory: [{ stato: 'Inviato', rilevatoIl: '2026-01-10T10:00:00.000Z' }] };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Inviato' } as any);

    await service.handleCron();

    expect(attempt.postalStatusHistory).toEqual([{ stato: 'Inviato', rilevatoIl: '2026-01-10T10:00:00.000Z' }]);
  });

  it('gestisce postalStatusHistory assente (null) su un attempt esistente senza storico pregresso', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Inviato', postalStatusUpdatedAt: null, postalStatusHistory: null };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Consegnato' } as any);

    await service.handleCron();

    expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'a1',
      postalStatusHistory: [{ stato: 'Consegnato', rilevatoIl: expect.any(String) }],
    }));
  });

  it('aggiorna comunque postalLastCheckedAt se lo stato non è cambiato (round-robin del cron)', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Inviato', postalStatusUpdatedAt: null };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Inviato' } as any);

    await service.handleCron();

    expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'a1',
      postalStatus: 'Inviato',
      postalLastCheckedAt: expect.any(Date),
    }));
  });

  it('ordina la query per ultimo controllo (COALESCE postal_last_checked_at/created_at), non per created_at fisso', async () => {
    const qb = makeQueryBuilder([]);
    attemptRepo.createQueryBuilder.mockReturnValue(qb);

    await service.handleCron();

    expect(qb.orderBy).toHaveBeenCalledWith(
      expect.stringContaining('postal_last_checked_at'),
      'ASC',
    );
  });

  it('logga e continua se dettagliDocumento fallisce per un attempt, senza bloccare gli altri', async () => {
    const attempt1 = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Inviato', postalStatusUpdatedAt: null };
    const attempt2 = { id: 'a2', postalTrackingId: 'IDPRO2', postalStatus: 'Inviato', postalStatusUpdatedAt: null };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt1, attempt2]));
    globalCom.dettagliDocumento
      .mockRejectedValueOnce(new Error('timeout SOAP'))
      .mockResolvedValueOnce({ idPro: 'IDPRO2', stato: 'Consegnato' } as any);

    await service.handleCron();

    // a1 (fallito) viene comunque salvato con postalLastCheckedAt aggiornato:
    // altrimenti resterebbe per sempre il candidato più "vecchio" nell'ORDER
    // BY ASC, riselezionato a ogni giro cron e mai superato (starvation degli
    // altri candidati dietro di lui in coda — bug reale corretto).
    expect(attemptRepo.save).toHaveBeenCalledTimes(2);
    expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', postalLastCheckedAt: expect.any(Date) }));
    expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'a2', postalStatus: 'Consegnato' }));
  });

  it('salva cost_cents e cost_breakdown quando dettagliDocumento ritorna Costo', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Confermato', postalStatusUpdatedAt: null, postalStatusHistory: null, costCents: null };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({
      idPro: 'IDPRO1',
      stato: 'Confermato',
      costoNetto: 4.31,
      numeroPagine: 2,
      nazionale: true,
      importoPostaleNetto: 4.03,
      importoStampaNetto: 0.28,
      importoARNetto: 0,
      tipoDocumento: 'RaccomandataMarket4',
      codiceContratto: '40009679559',
    });

    await service.handleCron();

    expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'a1',
      costCents: 431,
      costCalculatedAt: expect.any(Date),
      costBreakdown: {
        costoNetto: 4.31,
        numeroPagine: 2,
        nazionale: true,
        importoPostaleNetto: 4.03,
        importoStampaNetto: 0.28,
        importoARNetto: 0,
        tipoDocumento: 'RaccomandataMarket4',
        codiceContratto: '40009679559',
      },
    }));
  });

  it('include nella query gli attempt già terminali ma senza costo ancora calcolato', async () => {
    const qb = makeQueryBuilder([]);
    attemptRepo.createQueryBuilder.mockReturnValue(qb);

    await service.handleCron();

    const includesCostNull = qb.andWhere.mock.calls.some(([sql]: [string]) => /cost_cents/i.test(sql));
    expect(includesCostNull).toBe(true);
  });

  it('include nella query un attempt Eliminato con costo già calcolato ma mai controllato per riaccodamento', async () => {
    const qb = makeQueryBuilder([]);
    attemptRepo.createQueryBuilder.mockReturnValue(qb);

    await service.handleCron();

    const includesEliminatoRequeueCheck = qb.andWhere.mock.calls.some(
      ([sql]: [string]) => /postal_status = :eliminato/i.test(sql) && /postal_requeue_checked_at IS NULL/i.test(sql),
    );
    expect(includesEliminatoRequeueCheck).toBe(true);
  });

  it('non ricalcola il costo se cost_cents è già valorizzato e lo stato non cambia', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Confermato', postalStatusUpdatedAt: null, costCents: 431 };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Confermato', costoNetto: 4.31 } as any);

    await service.handleCron();

    expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', costCents: 431 }));
  });

  describe('controllo riaccodamento su stato Eliminato', () => {
    it('cron: rileva Eliminato senza riaccodamento — non crea nuovo attempt, stampa postalRequeueCheckedAt', async () => {
      const attempt = {
        id: 'a1', recipientId: 'r1', attemptNumber: 1,
        postalTrackingId: 'IDPRO1', postalStatus: 'Errore', postalStatusUpdatedAt: null,
        postalStatusHistory: [], postalRequeueCheckedAt: null,
      };
      attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
      globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Eliminato' } as any);
      globalCom.listaRiaccodamentiDocumento.mockResolvedValue(['IDPRO1']);

      await service.handleCron();

      expect(globalCom.listaRiaccodamentiDocumento).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: activeProvider.creds.baseUrl }),
        'IDPRO1',
      );
      expect(attemptRepo.create).not.toHaveBeenCalled();
      expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        id: 'a1', postalStatus: 'Eliminato', postalRequeueCheckedAt: expect.any(Date),
      }));
    });

    it('cron: rileva Eliminato con riaccodamento — crea nuovo attempt con l\'ultimo IDPRO della catena', async () => {
      const attempt = {
        id: 'a1', recipientId: 'r1', attemptNumber: 1, channelType: 'POSTAL',
        postalTrackingId: 'IDPRO1', postalStatus: 'Errore', postalStatusUpdatedAt: null,
        postalStatusHistory: [], postalRequeueCheckedAt: null,
      };
      attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
      globalCom.dettagliDocumento.mockImplementation(async (_creds: any, idPro: string) => {
        if (idPro === 'IDPRO1') return { idPro: 'IDPRO1', stato: 'Eliminato' } as any;
        return { idPro: 'IDPRO2', stato: 'Accettato', costoNetto: 4.31 } as any;
      });
      globalCom.listaRiaccodamentiDocumento.mockResolvedValue(['IDPRO1', 'IDPRO2']);
      attemptRepo.findOne
        .mockResolvedValueOnce(null) // idempotenza: nessun attempt esistente per IDPRO2
        .mockResolvedValueOnce({ attemptNumber: 1 }); // ultimo attempt del destinatario

      await service.handleCron();

      expect(attemptRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        recipientId: 'r1',
        channelType: 'POSTAL',
        status: 'success',
        attemptNumber: 2,
        postalTrackingId: 'IDPRO2',
        postalStatus: 'Accettato',
        costCents: 431,
      }));
      expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        postalTrackingId: 'IDPRO2', attemptNumber: 2,
      }));
      expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        id: 'a1', postalRequeueCheckedAt: expect.any(Date),
      }));
    });

    it('cron: non ripete il controllo se postalRequeueCheckedAt è già impostato', async () => {
      const attempt = {
        id: 'a1', recipientId: 'r1', attemptNumber: 1,
        postalTrackingId: 'IDPRO1', postalStatus: 'Eliminato', postalStatusUpdatedAt: null,
        postalStatusHistory: [], postalRequeueCheckedAt: new Date('2026-07-20T10:00:00.000Z'),
      };
      attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
      globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Eliminato' } as any);

      await service.handleCron();

      expect(globalCom.listaRiaccodamentiDocumento).not.toHaveBeenCalled();
    });

    it('manuale (refreshOne): ripete il controllo anche se postalRequeueCheckedAt è già impostato', async () => {
      const attempt = {
        id: 'a1', recipientId: 'r1', attemptNumber: 1, channelType: 'POSTAL',
        postalTrackingId: 'IDPRO1', postalStatus: 'Eliminato', postalStatusUpdatedAt: null,
        postalStatusHistory: [], postalRequeueCheckedAt: new Date('2026-07-20T10:00:00.000Z'),
      };
      attemptRepo.findOneBy = jest.fn().mockResolvedValue(attempt);
      globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Eliminato' } as any);
      globalCom.listaRiaccodamentiDocumento.mockResolvedValue(['IDPRO1']);

      await service.refreshOne('a1');

      expect(globalCom.listaRiaccodamentiDocumento).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: activeProvider.creds.baseUrl }),
        'IDPRO1',
      );
    });

    it('non crea un duplicato se esiste già un attempt per il nuovo IDPRO (idempotenza cron+manuale)', async () => {
      const attempt = {
        id: 'a1', recipientId: 'r1', attemptNumber: 1,
        postalTrackingId: 'IDPRO1', postalStatus: 'Eliminato', postalStatusUpdatedAt: null,
        postalStatusHistory: [], postalRequeueCheckedAt: null,
      };
      attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
      globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Eliminato' } as any);
      globalCom.listaRiaccodamentiDocumento.mockResolvedValue(['IDPRO1', 'IDPRO2']);
      attemptRepo.findOne.mockResolvedValueOnce({ id: 'a2', postalTrackingId: 'IDPRO2' });

      await service.handleCron();

      expect(attemptRepo.create).not.toHaveBeenCalled();
      expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        id: 'a1', postalRequeueCheckedAt: expect.any(Date),
      }));
    });

    it('errore SOAP nel controllo riaccodamento non blocca il salvataggio del postalStatus normale, e non stampa il flag', async () => {
      const attempt = {
        id: 'a1', recipientId: 'r1', attemptNumber: 1,
        postalTrackingId: 'IDPRO1', postalStatus: 'Errore', postalStatusUpdatedAt: null,
        postalStatusHistory: [], postalRequeueCheckedAt: null,
      };
      attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
      globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Eliminato' } as any);
      globalCom.listaRiaccodamentiDocumento.mockRejectedValue(new Error('timeout SOAP'));

      await service.handleCron();

      expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        id: 'a1', postalStatus: 'Eliminato',
      }));
      const savedCalls = attemptRepo.save.mock.calls.map((c: any[]) => c[0]);
      expect(savedCalls.some((s: any) => s.id === 'a1' && s.postalRequeueCheckedAt != null)).toBe(false);
    });
  });
});
