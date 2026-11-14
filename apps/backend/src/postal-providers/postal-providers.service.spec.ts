import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PostalProvidersService } from './postal-providers.service.js';
import { decryptValue, deriveSettingsKey } from '../settings/settings-crypto.js';
import { MASKED_VALUE } from '../settings/settings.registry.js';

const SECRET = 'test-jwt-secret-fittizio';
const KEY = deriveSettingsKey(SECRET);

function makeEntity(over: Record<string, unknown> = {}): any {
  return {
    id: 'p1', type: 'GLOBALCOM', name: 'GlobalCom ACME SRL', baseUrl: 'https://gbc.example/ws',
    username: 'user', passwordEnc: '', group: 'G', centroDiCosto: '',
    mittenteDenominazione1: '', mittenteIndirizzo1: '', mittenteCap: '', mittenteCitta: '', mittenteProvincia: '',
    enabledServiceTypes: [], contratti: [], testedAt: null, active: false,
    createdAt: new Date('2026-01-01'), ...over,
  };
}

describe('PostalProvidersService', () => {
  let repo: any;
  let globalCom: any;
  let service: PostalProvidersService;

  beforeEach(() => {
    repo = {
      find: jest.fn(),
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      delete: jest.fn(),
      create: jest.fn((x: any) => ({ id: 'new-id', ...x })),
      save: jest.fn(async (x: any) => x),
    };
    globalCom = { informazioniUtenza: jest.fn() };
    const config = { get: jest.fn().mockReturnValue(SECRET) };
    service = new PostalProvidersService(repo, globalCom, config as any);
  });

  const createDto = (over: Record<string, unknown> = {}): any => ({
    type: 'GLOBALCOM', name: 'GlobalCom ACME SRL', baseUrl: 'https://gbc.example/ws',
    username: 'user', password: 'pw-in-chiaro', group: 'G', ...over,
  });

  describe('create', () => {
    it('salva la password cifrata (non in chiaro, decifrabile) e restituisce il DTO mascherato', async () => {
      const dto = await service.create(createDto());

      const persisted = repo.save.mock.calls[0][0];
      expect(persisted.passwordEnc).not.toBe('pw-in-chiaro');
      expect(persisted.passwordEnc).not.toContain('pw-in-chiaro');
      expect(decryptValue(persisted.passwordEnc, KEY)).toBe('pw-in-chiaro');
      expect(persisted.active).toBe(false);
      expect(dto.password).toBe(MASKED_VALUE);
      expect(JSON.stringify(dto)).not.toContain('pw-in-chiaro');
      expect(dto).not.toHaveProperty('passwordEnc');
    });

    it('senza password → passwordEnc vuota e DTO con password vuota', async () => {
      const dto = await service.create(createDto({ password: '' }));
      expect(repo.save.mock.calls[0][0].passwordEnc).toBe('');
      expect(dto.password).toBe('');
    });
  });

  describe('listMasked', () => {
    it('non espone nessun segreto in chiaro né cifrato', async () => {
      const first = await service.create(createDto());
      const enc = repo.save.mock.calls[0][0].passwordEnc;
      repo.find.mockResolvedValue([makeEntity({ passwordEnc: enc }), makeEntity({ id: 'p2', passwordEnc: '' })]);

      const list = await service.listMasked();

      expect(repo.find).toHaveBeenCalledWith({ order: { createdAt: 'ASC' } });
      expect(list.map((l) => l.password)).toEqual([MASKED_VALUE, '']);
      const json = JSON.stringify(list);
      expect(json).not.toContain('pw-in-chiaro');
      expect(json).not.toContain(enc);
      expect(first.password).toBe(MASKED_VALUE);
    });
  });

  describe('update', () => {
    it('id inesistente → NotFoundException', async () => {
      repo.findOneBy.mockResolvedValue(null);
      await expect(service.update('x', { name: 'n' })).rejects.toThrow(NotFoundException);
    });

    it('MASKED_VALUE nel campo password → secret invariato e test non invalidato', async () => {
      const tested = new Date('2026-02-02');
      const entity = makeEntity({ passwordEnc: 'enc:v1:originale', testedAt: tested, active: true, enabledServiceTypes: ['AR'] });
      repo.findOneBy.mockResolvedValue(entity);

      await service.update('p1', { password: MASKED_VALUE, name: 'Nuovo nome' });

      expect(entity.passwordEnc).toBe('enc:v1:originale');
      expect(entity.name).toBe('Nuovo nome');
      expect(entity.testedAt).toBe(tested);
      expect(entity.active).toBe(true);
      expect(entity.enabledServiceTypes).toEqual(['AR']);
    });

    it('password nuova → ricifrata, e invalida test/attivazione/contratti', async () => {
      const entity = makeEntity({
        passwordEnc: 'enc:v1:originale', testedAt: new Date(), active: true,
        enabledServiceTypes: ['AR'], contratti: [{ codiceContratto: 'C1' }],
      });
      repo.findOneBy.mockResolvedValue(entity);

      const dto = await service.update('p1', { password: 'nuova-pw' });

      expect(entity.passwordEnc).not.toBe('enc:v1:originale');
      expect(entity.passwordEnc).not.toContain('nuova-pw');
      expect(decryptValue(entity.passwordEnc, KEY)).toBe('nuova-pw');
      expect(entity.testedAt).toBeNull();
      expect(entity.active).toBe(false);
      expect(entity.enabledServiceTypes).toEqual([]);
      expect(entity.contratti).toEqual([]);
      expect(dto.password).toBe(MASKED_VALUE);
    });

    it('password vuota → azzera il secret', async () => {
      const entity = makeEntity({ passwordEnc: 'enc:v1:originale' });
      repo.findOneBy.mockResolvedValue(entity);
      const dto = await service.update('p1', { password: '' });
      expect(entity.passwordEnc).toBe('');
      expect(dto.password).toBe('');
    });

    it('campo non sensibile (name) → non invalida il test', async () => {
      const entity = makeEntity({ testedAt: new Date(), active: true });
      repo.findOneBy.mockResolvedValue(entity);
      await service.update('p1', { name: 'altro' });
      expect(entity.active).toBe(true);
      expect(entity.testedAt).not.toBeNull();
    });
  });

  describe('remove', () => {
    it('inesistente → NotFoundException', async () => {
      repo.delete.mockResolvedValue({ affected: 0 });
      await expect(service.remove('x')).rejects.toThrow(NotFoundException);
    });
    it('esistente → elimina', async () => {
      repo.delete.mockResolvedValue({ affected: 1 });
      await expect(service.remove('p1')).resolves.toBeUndefined();
      expect(repo.delete).toHaveBeenCalledWith({ id: 'p1' });
    });
  });

  describe('setActive', () => {
    it('id inesistente → NotFoundException', async () => {
      repo.findOneBy.mockResolvedValue(null);
      await expect(service.setActive('x', true)).rejects.toThrow(NotFoundException);
    });

    it('mai testato → BadRequestException e nessun salvataggio', async () => {
      repo.findOneBy.mockResolvedValue(makeEntity());
      await expect(service.setActive('p1', true)).rejects.toThrow(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('testato → attiva SENZA disattivare gli altri provider', async () => {
      // KNOWN_GAPS: setActive non disattiva gli altri provider attivi (decisione di prodotto):
      // possono coesistere più provider attivi; getActive ne sceglie uno solo (il più vecchio).
      const entity = makeEntity({ testedAt: new Date() });
      repo.findOneBy.mockResolvedValue(entity);

      const dto = await service.setActive('p1', true);

      expect(dto.active).toBe(true);
      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(repo.save).toHaveBeenCalledWith(entity);
      expect(repo.find).not.toHaveBeenCalled();
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('disattivazione consentita anche se mai testato', async () => {
      const entity = makeEntity({ active: true });
      repo.findOneBy.mockResolvedValue(entity);
      const dto = await service.setActive('p1', false);
      expect(dto.active).toBe(false);
    });
  });

  describe('getActive', () => {
    it('nessun attivo → null', async () => {
      repo.findOne.mockResolvedValue(null);
      expect(await service.getActive()).toBeNull();
    });

    it('con più provider attivi interroga ordinando per createdAt ASC → il più vecchio', async () => {
      // KNOWN_GAPS: con due attivi vince il più vecchio (createdAt ASC), non l'ultimo attivato.
      await service.create(createDto());
      const enc = repo.save.mock.calls[0][0].passwordEnc;
      const oldest = makeEntity({ id: 'old', active: true, passwordEnc: enc, createdAt: new Date('2025-01-01') });
      const newer = makeEntity({ id: 'new', active: true, createdAt: new Date('2026-01-01') });
      // Simula l'ordinamento del DB rispettando l'`order` richiesto.
      repo.findOne.mockImplementation(async ({ where, order }: any) => {
        const rows = [newer, oldest].filter((r) => r.active === where.active);
        rows.sort((a, b) => (order.createdAt === 'ASC' ? 1 : -1) * (a.createdAt.getTime() - b.createdAt.getTime()));
        return rows[0];
      });

      const res = await service.getActive();

      expect(repo.findOne).toHaveBeenCalledWith({ where: { active: true }, order: { createdAt: 'ASC' } });
      expect(res!.id).toBe('old');
      expect(res!.creds.password).toBe('pw-in-chiaro');
      expect(res!.mittente).toBeNull();
    });

    it('password non decifrabile (secret cambiato) → password vuota, nessuna eccezione', async () => {
      repo.findOne.mockResolvedValue(makeEntity({ active: true, passwordEnc: 'enc:v1:xx:yy:zz' }));
      const res = await service.getActive();
      expect(res!.creds.password).toBe('');
    });

    it('mittente valorizzato e centroDiCosto', async () => {
      repo.findOne.mockResolvedValue(makeEntity({
        active: true, centroDiCosto: 'CC1', mittenteDenominazione1: 'Comune', mittenteIndirizzo1: 'Via Roma 1',
        mittenteCap: '00100', mittenteCitta: 'Roma', mittenteProvincia: 'RM',
      }));
      const res = await service.getActive();
      expect(res!.centroDiCosto).toBe('CC1');
      expect(res!.mittente).toEqual({
        denominazione1: 'Comune', indirizzo1: 'Via Roma 1', cap: '00100', citta: 'Roma', provincia: 'RM',
      });
    });
  });

  describe('test', () => {
    it('id inesistente → NotFoundException', async () => {
      repo.findOneBy.mockResolvedValue(null);
      await expect(service.test('x')).rejects.toThrow(NotFoundException);
    });

    it('successo → salva servizi/contratti, testedAt, active, e ritorna success', async () => {
      const entity = makeEntity();
      repo.findOneBy.mockResolvedValue(entity);
      globalCom.informazioniUtenza.mockResolvedValue({
        operazioneRiuscita: true, prodottiDisponibili: ['AR', 'RIR'],
        contratti: [{ codiceContratto: 'C1', descrizione: 'd', tipologia: 't', estero: false }],
        centroDiCosto: 'CC9',
      });

      const res = await service.test('p1');

      expect(res.success).toBe(true);
      expect(res.message).toContain('2 tipologie');
      expect(res.message).toContain('1 contratti');
      expect(entity.enabledServiceTypes).toEqual(['AR', 'RIR']);
      expect(entity.centroDiCosto).toBe('CC9');
      expect(entity.active).toBe(true);
      expect(entity.testedAt).toBeInstanceOf(Date);
      expect(repo.save).toHaveBeenCalledWith(entity);
    });

    it('successo non sovrascrive un centroDiCosto già impostato', async () => {
      const entity = makeEntity({ centroDiCosto: 'MIO' });
      repo.findOneBy.mockResolvedValue(entity);
      globalCom.informazioniUtenza.mockResolvedValue({
        operazioneRiuscita: true, prodottiDisponibili: [], contratti: [], centroDiCosto: 'CC9',
      });
      await service.test('p1');
      expect(entity.centroDiCosto).toBe('MIO');
    });

    it('operazione non riuscita → success false col messaggio GlobalCom, nessun salvataggio', async () => {
      repo.findOneBy.mockResolvedValue(makeEntity());
      globalCom.informazioniUtenza.mockResolvedValue({
        operazioneRiuscita: false, messaggioErrore: 'Credenziali errate', prodottiDisponibili: [], contratti: [],
      });
      const res = await service.test('p1');
      expect(res).toEqual({ success: false, message: 'Credenziali errate' });
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('operazione non riuscita senza messaggio → messaggio di default', async () => {
      repo.findOneBy.mockResolvedValue(makeEntity());
      globalCom.informazioniUtenza.mockResolvedValue({
        operazioneRiuscita: false, messaggioErrore: '', prodottiDisponibili: [], contratti: [],
      });
      const res = await service.test('p1');
      expect(res.message).toBe('Recupero informazioni utenza fallito');
    });

    it('errore di connessione → success false, non propaga', async () => {
      repo.findOneBy.mockResolvedValue(makeEntity());
      globalCom.informazioniUtenza.mockRejectedValue(new Error('ECONNREFUSED'));
      const res = await service.test('p1');
      expect(res).toEqual({ success: false, message: 'Errore connessione: ECONNREFUSED' });
      expect(repo.save).not.toHaveBeenCalled();
    });
  });
});
