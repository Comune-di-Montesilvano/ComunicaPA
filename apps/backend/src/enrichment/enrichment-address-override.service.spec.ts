import { EnrichmentAddressOverrideService } from './enrichment-address-override.service';

describe('EnrichmentAddressOverrideService', () => {
  let repo: any;
  let service: EnrichmentAddressOverrideService;

  beforeEach(() => {
    repo = {
      upsert: jest.fn(async () => undefined),
      findOneBy: jest.fn(async () => ({ id: 'o1', jobId: 'j1', pdfFilename: 'PROVV_1.pdf', indirizzo: 'VIA NUOVA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', statoEstero: null, correctedBy: 'op', correctedAt: new Date() })),
      find: jest.fn(async () => []),
    };
    service = new EnrichmentAddressOverrideService(repo);
  });

  it('upsert scrive su (jobId, pdfFilename) e ritorna la riga salvata', async () => {
    const result = await service.upsert('j1', 'PROVV_1.pdf', { indirizzo: 'VIA NUOVA 1', cap: '00100', comune: 'ROMA', provincia: 'RM' }, null, 'op');
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'j1', pdfFilename: 'PROVV_1.pdf', indirizzo: 'VIA NUOVA 1', extraFields: null, correctedBy: 'op' }),
      ['jobId', 'pdfFilename'],
    );
    expect(result.indirizzo).toBe('VIA NUOVA 1');
  });

  it('upsert con extraFields non vuoto lo scrive, vuoto/assente lo scrive null', async () => {
    await service.upsert('j1', 'PROVV_1.pdf', {}, { importo: '100,00' }, 'op');
    expect(repo.upsert).toHaveBeenCalledWith(expect.objectContaining({ extraFields: { importo: '100,00' } }), ['jobId', 'pdfFilename']);

    await service.upsert('j1', 'PROVV_1.pdf', {}, {}, 'op');
    expect(repo.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ extraFields: null }), ['jobId', 'pdfFilename']);
  });

  it('findByJob ritorna tutti gli override del job', async () => {
    repo.find.mockResolvedValue([{ pdfFilename: 'PROVV_1.pdf' }]);
    const result = await service.findByJob('j1');
    expect(repo.find).toHaveBeenCalledWith({ where: { jobId: 'j1' } });
    expect(result).toEqual([{ pdfFilename: 'PROVV_1.pdf' }]);
  });

  it('applyOverrides patcha solo le righe con allegato matchato, non muta l\'array originale', () => {
    const rows = [
      { allegato: 'PROVV_1.pdf', indirizzo: 'VIA VECCHIA', cap: '00000', comune: 'X', provincia: 'XX', stato_estero: '' },
      { allegato: 'PROVV_2.pdf', indirizzo: 'INVARIATA', cap: '11111', comune: 'Y', provincia: 'YY', stato_estero: '' },
    ];
    const overrides = [
      { jobId: 'j1', pdfFilename: 'PROVV_1.pdf', indirizzo: 'VIA NUOVA', cap: '00100', comune: 'ROMA', provincia: 'RM', statoEstero: null } as any,
    ];
    const patched = service.applyOverrides(rows, overrides);
    expect(patched[0].indirizzo).toBe('VIA NUOVA');
    expect(patched[0].cap).toBe('00100');
    expect(patched[1].indirizzo).toBe('INVARIATA');
    expect(rows[0].indirizzo).toBe('VIA VECCHIA'); // input non mutato
  });

  it('applyOverrides con statoEstero valorizzato patcha anche stato_estero', () => {
    const rows = [{ allegato: 'PROVV_1.pdf', indirizzo: 'X', cap: 'Y', comune: 'Z', provincia: 'W', stato_estero: '' }];
    const overrides = [{ jobId: 'j1', pdfFilename: 'PROVV_1.pdf', indirizzo: 'VIA ESTERA', cap: '', comune: 'BRUXELLES', provincia: '', statoEstero: 'Belgio' } as any];
    const patched = service.applyOverrides(rows, overrides);
    expect(patched[0].stato_estero).toBe('Belgio');
  });

  it('applyOverrides applica anche extraFields (correzione PDF illeggibile: nessun dato estratto)', () => {
    const rows = [{ allegato: 'PROVV_1.pdf', importo: '', scadenza: '', numero_avviso: '' }];
    const overrides = [{
      jobId: 'j1', pdfFilename: 'PROVV_1.pdf', indirizzo: null, cap: null, comune: null, provincia: null, statoEstero: null,
      extraFields: { importo: '761,00', scadenza: '31/12/2026', numero_avviso: '12345' },
    } as any];
    const patched = service.applyOverrides(rows, overrides);
    expect(patched[0].importo).toBe('761,00');
    expect(patched[0].scadenza).toBe('31/12/2026');
    expect(patched[0].numero_avviso).toBe('12345');
  });
});
