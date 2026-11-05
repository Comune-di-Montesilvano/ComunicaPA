import { describe, it, expect } from 'vitest';
import { parsePosteResponse, mapPosteOutcome, lastMovement, PosteTrackingError, posteDataOraToDate } from './poste-tracking-mapping.util.js';

const delivered = {
  idTracciatura: 'RN000000000IT',
  tipoProdotto: 'RACC. DA/PER ESTERO',
  esitoRicerca: '3',
  stato: '5',
  flagRitorno: false,
  listaMovimenti: [
    { dataOra: 1785393537000, statoLavorazione: 'a seguito di acquisto da poste.it', luogo: 'sito poste.it', flagRitorno: false, box: '2' },
    { dataOra: 1786508340000, statoLavorazione: 'in data', luogo: 'SVIZZERA', flagRitorno: false, box: '3' },
    { dataOra: 1788509160000, statoLavorazione: 'con successo in data', luogo: 'SVIZZERA', flagRitorno: false, box: '5' },
  ],
};

describe('parsePosteResponse', () => {
  it('normalizza movimenti (epoch ms → ISO) e conserva la risposta grezza', () => {
    const r = parsePosteResponse(delivered);
    expect(r.esitoRicerca).toBe('3');
    expect(r.stato).toBe('5');
    expect(r.tipoProdotto).toBe('RACC. DA/PER ESTERO');
    expect(r.movements).toHaveLength(3);
    expect(r.movements[2]).toEqual({ at: '2026-09-04T06:06:00.000Z', luogo: 'SVIZZERA', statoLavorazione: 'con successo in data', box: '5', flagRitorno: false });
    expect(r.raw).toBe(delivered);
  });

  it('codice non trovato: nessun movimento', () => {
    const r = parsePosteResponse({ idTracciatura: 'X', esitoRicerca: '1', stato: '1' });
    expect(r.movements).toEqual([]);
    expect(r.flagRitorno).toBe(false);
  });

  it('body non oggetto o senza esitoRicerca → PosteTrackingError invalid_body', () => {
    for (const body of [null, 'html', 42, [], { foo: 1 }]) {
      expect(() => parsePosteResponse(body)).toThrow(PosteTrackingError);
    }
    try { parsePosteResponse('x'); } catch (e) { expect((e as PosteTrackingError).kind).toBe('invalid_body'); }
  });
});

describe('posteDataOraToDate (ora italiana codificata come UTC)', () => {
  it('ora legale: −2 h (caso reale: consegnata 11:20:24Z = 09:20:24Z, come SEND)', () => {
    expect(posteDataOraToDate(Date.parse('2026-09-17T11:20:24Z')).toISOString()).toBe('2026-09-17T09:20:24.000Z');
  });
  it('ora solare: −1 h', () => {
    expect(posteDataOraToDate(Date.parse('2026-11-05T19:38:07Z')).toISOString()).toBe('2026-11-05T18:38:07.000Z');
  });
  it('a cavallo del cambio ora (25/10/2026, 03:00 legale → 02:00 solare)', () => {
    expect(posteDataOraToDate(Date.parse('2026-10-25T01:30:00Z')).toISOString()).toBe('2026-10-24T23:30:00.000Z');
    expect(posteDataOraToDate(Date.parse('2026-10-25T04:00:00Z')).toISOString()).toBe('2026-10-25T03:00:00.000Z');
    expect(posteDataOraToDate(Date.parse('2026-03-29T03:30:00Z')).toISOString()).toBe('2026-03-29T01:30:00.000Z');
    expect(posteDataOraToDate(Date.parse('2026-03-29T01:30:00Z')).toISOString()).toBe('2026-03-29T00:30:00.000Z');
  });
});

describe('lastMovement', () => {
  it('prende il box più alto, a parità il più recente', () => {
    const m = parsePosteResponse(delivered).movements;
    expect(lastMovement(m)?.box).toBe('5');
    expect(lastMovement([])).toBeNull();
    const tie = [
      { at: '2026-01-01T00:00:00.000Z', luogo: 'A', statoLavorazione: '', box: '4', flagRitorno: false },
      { at: '2026-01-02T00:00:00.000Z', luogo: 'B', statoLavorazione: '', box: '4', flagRitorno: false },
    ];
    expect(lastMovement(tie)?.luogo).toBe('B');
  });
});

describe('mapPosteOutcome', () => {
  it('esito 3 + stato 5 senza ritorno → delivered con data ultimo movimento', () => {
    const { outcome, outcomeAt } = mapPosteOutcome(parsePosteResponse(delivered));
    expect(outcome).toBe('delivered');
    expect(outcomeAt?.toISOString()).toBe('2026-09-04T06:06:00.000Z');
  });

  it('flagRitorno in testa → returned anche con stato 5', () => {
    expect(mapPosteOutcome(parsePosteResponse({ ...delivered, flagRitorno: true })).outcome).toBe('returned');
  });

  it('flagRitorno su un movimento → returned, con data esito = ultimo movimento', () => {
    const body = { ...delivered, listaMovimenti: [...delivered.listaMovimenti, { dataOra: 1788600000000, statoLavorazione: 'x', luogo: 'Y', flagRitorno: true, box: '5' }] };
    const r = mapPosteOutcome(parsePosteResponse(body));
    expect(r.outcome).toBe('returned');
    expect(r.outcomeAt?.toISOString()).toBe(posteDataOraToDate(1788600000000).toISOString());
  });

  it('esitoRicerca 1 (non trovato) → pending', () => {
    expect(mapPosteOutcome(parsePosteResponse({ esitoRicerca: '1', stato: '1' }))).toEqual({ outcome: 'pending', outcomeAt: null });
  });

  it('stato intermedio o sconosciuto → pending', () => {
    expect(mapPosteOutcome(parsePosteResponse({ ...delivered, stato: '4' })).outcome).toBe('pending');
    expect(mapPosteOutcome(parsePosteResponse({ ...delivered, esitoRicerca: '2' })).outcome).toBe('pending');
  });
});

describe('consegna al mittente (ritorno senza flagRitorno)', () => {
  const returnedAbroad = {
    esitoRicerca: '3', stato: '5', flagRitorno: false, tipoProdotto: 'Raccomandata internazionale',
    listaMovimenti: [
      { dataOra: 1785393537000, statoLavorazione: 'a seguito di acquisto da poste.it', luogo: 'sito poste.it', flagRitorno: false, box: '2' },
      { dataOra: 1787814060000, statoLavorazione: 'in data', luogo: 'PESCARA (PE)', flagRitorno: false, box: '3' },
      { dataOra: 1787824680000, statoLavorazione: 'in data', luogo: 'MONTESILVANO (PE)', flagRitorno: false, box: '4' },
      { dataOra: 1787839380000, statoLavorazione: 'con successo in data', luogo: 'MONTESILVANO (PE)', flagRitorno: false, box: '5' },
    ],
  };

  it('destinatario estero ma consegna registrata in Italia → returned', () => {
    const r = mapPosteOutcome(parsePosteResponse(returnedAbroad), { recipientForeign: true, recipientCity: 'GRAZ', senderCity: 'MONTESILVANO' });
    expect(r.outcome).toBe('returned');
    expect(r.outcomeAt?.getTime()).toBe(posteDataOraToDate(1787839380000).getTime());
  });

  it('destinatario estero con consegna all\'estero (luogo senza provincia) → delivered', () => {
    expect(mapPosteOutcome(parsePosteResponse(delivered), { recipientForeign: true, recipientCity: 'ZURIGO', senderCity: 'MONTESILVANO' }).outcome).toBe('delivered');
  });

  it('domestico: consegna nella città del mittente, destinatario altrove → returned', () => {
    expect(mapPosteOutcome(parsePosteResponse(returnedAbroad), { recipientForeign: false, recipientCity: 'VASTO', senderCity: 'Montesilvano' }).outcome).toBe('returned');
  });

  it('domestico: destinatario nella stessa città del mittente → delivered (non distinguibile)', () => {
    expect(mapPosteOutcome(parsePosteResponse(returnedAbroad), { recipientForeign: false, recipientCity: 'MONTESILVANO', senderCity: 'MONTESILVANO' }).outcome).toBe('delivered');
  });

  it('senza contesto: comportamento invariato', () => {
    expect(mapPosteOutcome(parsePosteResponse(returnedAbroad)).outcome).toBe('delivered');
  });
});
