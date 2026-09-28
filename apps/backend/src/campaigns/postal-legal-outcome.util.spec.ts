import {
  postalLegalOutcome,
  postalLegalOutcomeCaseSql,
  postalLegalOutcomeSql,
  isPostalLegalOutcome,
  POSTAL_LEGAL_OUTCOME_LABELS,
  type PostalLegalOutcomeInput,
  type LegalOutcomeAttempt,
} from './postal-legal-outcome.util.js';

const D = (s: string) => new Date(s);

function attempt(over: Partial<LegalOutcomeAttempt> = {}): LegalOutcomeAttempt {
  return { status: 'success', postalStatus: 'Confermato', postalDeliveryStatus: null, postalDeliveryDate: null, sentAt: D('2026-07-30T08:00:00Z'), ...over };
}
function input(over: Partial<PostalLegalOutcomeInput> = {}): PostalLegalOutcomeInput {
  return { diverted: false, arTracking: true, attempt: attempt(), poste: null, ...over };
}

describe('postalLegalOutcome', () => {
  it('dirottato INAD → delivered via PEC con data invio PEC', () => {
    const r = postalLegalOutcome(input({ diverted: true, attempt: attempt({ postalStatus: null, sentAt: D('2026-08-01T10:00:00Z') }) }));
    expect(r).toEqual({ outcome: 'delivered', reason: 'Via PEC', at: D('2026-08-01T10:00:00Z') });
  });

  it('dirottato con PEC fallita → not_delivered, mai consegnato', () => {
    const r = postalLegalOutcome(input({ diverted: true, attempt: attempt({ status: 'failed', postalStatus: null, sentAt: null, errorMessage: 'Casella PEC piena' }) }));
    expect(r).toEqual({ outcome: 'not_delivered', reason: 'Casella PEC piena', at: null });
    expect(postalLegalOutcome(input({ diverted: true, attempt: attempt({ status: 'failed', postalStatus: null, sentAt: null }) })).reason).toBe('PEC non inviata');
  });

  it('dirottato con PEC non ancora partita o senza tentativi → in_progress', () => {
    expect(postalLegalOutcome(input({ diverted: true, attempt: null })).outcome).toBe('in_progress');
    expect(postalLegalOutcome(input({ diverted: true, attempt: attempt({ status: 'queued', postalStatus: null, sentAt: null }) })).outcome).toBe('in_progress');
  });

  it('GlobalCom Consegnato senza StatoConsegna → delivered con data consegna', () => {
    const r = postalLegalOutcome(input({ attempt: attempt({ postalStatus: 'Consegnato', postalDeliveryStatus: null, postalDeliveryDate: D('2026-09-10T00:00:00Z') }) }));
    expect(r).toEqual({ outcome: 'delivered', reason: 'Consegnato', at: D('2026-09-10T00:00:00Z') });
  });

  it('App IO esclusiva → no_legal_value', () => {
    expect(postalLegalOutcome(input({ attempt: attempt({ postalStatus: 'AppIoSostituito' }) })).outcome).toBe('no_legal_value');
  });

  it('senza AR → no_ar, ma dirottato e App IO restano i loro', () => {
    expect(postalLegalOutcome(input({ arTracking: false })).outcome).toBe('no_ar');
    expect(postalLegalOutcome(input({ arTracking: false, diverted: true })).outcome).toBe('delivered');
    expect(postalLegalOutcome(input({ arTracking: false, attempt: attempt({ postalStatus: 'AppIoSostituito' }) })).outcome).toBe('no_legal_value');
  });

  it('nessun tentativo → in_progress', () => {
    expect(postalLegalOutcome(input({ attempt: null }))).toEqual({ outcome: 'in_progress', reason: null, at: null });
  });

  it('tentativo fallito → not_delivered col messaggio di errore', () => {
    const r = postalLegalOutcome(input({ attempt: attempt({ status: 'failed', postalStatus: null, errorMessage: 'CAP non valido' }) }));
    expect(r).toEqual({ outcome: 'not_delivered', reason: 'CAP non valido', at: null });
  });

  it('Errore GlobalCom → not_delivered con codice e descrizione dallo storico', () => {
    const r = postalLegalOutcome(input({ attempt: attempt({ postalStatus: 'Errore', postalStatusHistory: [{ codiceErrore: '0' }, { codiceErrore: '1327', descrizione: 'Nazione in zona non ammessa' }] }) }));
    expect(r).toEqual({ outcome: 'not_delivered', reason: '1327: Nazione in zona non ammessa', at: null });
  });

  it('Errore GlobalCom senza storico → motivo generico', () => {
    expect(postalLegalOutcome(input({ attempt: attempt({ postalStatus: 'Errore' }) })).reason).toBe('Errore GlobalCom');
  });

  it.each(['Consegnato', 'Consegnato a Domicilio', 'Consegnato a Sportello', 'Consegnato in Digitale', 'Compiuta Giacenza', 'Invio Rifiutato'])(
    '%s → delivered con DataConsegna GlobalCom',
    (v) => {
      const r = postalLegalOutcome(input({ attempt: attempt({ postalStatus: v === 'Consegnato' ? 'Consegnato' : 'NonConsegnato', postalDeliveryStatus: v, postalDeliveryDate: D('2026-09-08T00:00:00Z') }) }));
      expect(r).toEqual({ outcome: 'delivered', reason: v, at: D('2026-09-08T00:00:00Z') });
    },
  );

  it('Compiuta Giacenza con Poste returned → resta delivered (motivo GlobalCom)', () => {
    const r = postalLegalOutcome(input({ attempt: attempt({ postalStatus: 'NonConsegnato', postalDeliveryStatus: 'Compiuta Giacenza', postalDeliveryDate: D('2026-09-08T00:00:00Z') }), poste: { status: 'returned', outcomeAt: D('2026-09-18T14:00:00Z') } }));
    expect(r).toEqual({ outcome: 'delivered', reason: 'Compiuta Giacenza', at: D('2026-09-08T00:00:00Z') });
  });

  it('Indirizzo errato con Poste delivered → delivered da verifica Poste', () => {
    const r = postalLegalOutcome(input({ attempt: attempt({ postalStatus: 'NonConsegnato', postalDeliveryStatus: 'Indirizzo errato o inesatto' }), poste: { status: 'delivered', outcomeAt: D('2026-09-04T09:00:00Z') } }));
    expect(r).toEqual({ outcome: 'delivered', reason: 'Verifica Poste', at: D('2026-09-04T09:00:00Z') });
  });

  it('Confermato fermo con Poste delivered → delivered da verifica Poste', () => {
    expect(postalLegalOutcome(input({ poste: { status: 'delivered', outcomeAt: D('2026-08-03T14:00:00Z') } })).outcome).toBe('delivered');
  });

  it.each(['Destinatario deceduto', 'Destinatario irreperibile', 'Destinatario sconosciuto', 'Destinatario trasferito', 'Indirizzo errato o inesatto', 'Indirizzo insufficiente', 'Indirizzo sconosciuto', 'Smarrito', 'Inesitato'])(
    '%s → not_delivered',
    (v) => {
      expect(postalLegalOutcome(input({ attempt: attempt({ postalStatus: 'NonConsegnato', postalDeliveryStatus: v }) }))).toEqual({ outcome: 'not_delivered', reason: v, at: null });
    },
  );

  it('Poste returned da sola non cambia l\'esito', () => {
    expect(postalLegalOutcome(input({ poste: { status: 'returned', outcomeAt: D('2026-09-01T00:00:00Z') } })).outcome).toBe('in_progress');
  });

  it('Eliminato → unclassified con stato grezzo', () => {
    expect(postalLegalOutcome(input({ attempt: attempt({ postalStatus: 'Eliminato' }) }))).toEqual({ outcome: 'unclassified', reason: 'Eliminato', at: null });
  });

  it('valore sconosciuto → in_progress, mai delivered', () => {
    expect(postalLegalOutcome(input({ attempt: attempt({ postalDeliveryStatus: 'Valore mai visto' }) }))).toEqual({ outcome: 'in_progress', reason: 'Valore mai visto', at: null });
  });

  it('In giacenza / Accettato online → in_progress', () => {
    expect(postalLegalOutcome(input({ attempt: attempt({ postalDeliveryStatus: 'In giacenza' }) })).outcome).toBe('in_progress');
    expect(postalLegalOutcome(input({ attempt: attempt({ postalDeliveryStatus: 'Accettato online' }) })).outcome).toBe('in_progress');
  });
});

describe('postalLegalOutcomeCaseSql / postalLegalOutcomeSql', () => {
  it('con AR contiene tutte le regole nell\'ordine della spec', () => {
    const sql = postalLegalOutcomeCaseSql(true);
    const order = ["AND la.status = 'success'", "AND la.status = 'failed'", "false) THEN 'in_progress'", 'AppIoSostituito', 'la.id IS NULL', "WHEN la.status = 'failed'", "la.postal_status = 'Errore'", "'Compiuta Giacenza'", "la.postal_status = 'Consegnato'", "ppt.status = 'delivered'", "'Smarrito'", "'Eliminato'"]
      .map((frag) => sql.indexOf(frag));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('senza AR: dopo dirottato e App IO tutto no_ar', () => {
    const sql = postalLegalOutcomeCaseSql(false);
    expect(sql).toContain("ELSE 'no_ar'");
    expect(sql).not.toContain('Compiuta Giacenza');
  });

  it('sottoquery scalare correlata al destinatario, sempre una riga', () => {
    const sql = postalLegalOutcomeSql(true, 'rx');
    expect(sql).toContain('na.recipient_id = rx.id');
    expect(sql).toContain('LEFT JOIN LATERAL');
    expect(sql).toContain('rx.inad_check');
  });

  it('valori quotati come letterali SQL', () => {
    expect(postalLegalOutcomeCaseSql(true)).toContain("'Invio Rifiutato'");
    expect(postalLegalOutcomeCaseSql(true)).toContain("'Indirizzo errato o inesatto'");
  });
});

describe('isPostalLegalOutcome / labels', () => {
  it('riconosce solo i codici', () => {
    expect(isPostalLegalOutcome('delivered')).toBe(true);
    expect(isPostalLegalOutcome('Consegnato')).toBe(false);
    expect(Object.keys(POSTAL_LEGAL_OUTCOME_LABELS).sort()).toEqual(['delivered', 'in_progress', 'no_ar', 'no_legal_value', 'not_delivered', 'unclassified']);
  });
});
