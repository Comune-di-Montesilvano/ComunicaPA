import { describe, it, expect } from 'vitest';
import {
  buildJourney,
  computeVerdict,
  isPosteLetterCode,
  latestAttempt,
  latestSendPosteLetter,
  posteTrackingUrl,
  sendAttemptName,
  sendPosteLetters,
  sourceLabel,
  type JourneyAttempt,
  type JourneyDetail,
  type JourneyLabels,
} from '../src/components/notification-detail/journey';

const labels: JourneyLabels = {
  channel: (c) => (c === 'EMAIL' ? 'Email' : c),
  postalStatus: (s) => `GC:${s}`,
  sendStatus: (s) => `SEND:${s}`,
};

const attempt = (over: Partial<JourneyAttempt> = {}): JourneyAttempt => ({
  attemptNumber: 1,
  status: 'sent',
  channelType: 'EMAIL',
  errorMessage: null,
  sentAt: '2026-03-10T09:00:05.000Z',
  createdAt: '2026-03-10T09:00:00.000Z',
  appIo: { attempted: false },
  ...over,
});

const detail = (channelType: string, attempts: JourneyAttempt[], over: Partial<JourneyDetail> = {}): JourneyDetail => ({
  recipient: { status: 'sent' },
  campaign: { channelType },
  attempts,
  downloads: [],
  ...over,
});

describe('helper del percorso', () => {
  it('sourceLabel', () => {
    expect(sourceLabel('poste')).toBe('Poste Italiane');
    expect(sourceLabel('appio')).toBe('App IO');
  });

  it('latestAttempt: il numero di tentativo più alto, null se vuoto', () => {
    expect(latestAttempt(detail('EMAIL', []))).toBeNull();
    expect(latestAttempt(detail('EMAIL', [attempt({ attemptNumber: 2 }), attempt({ attemptNumber: 3 }), attempt({ attemptNumber: 1 })]))?.attemptNumber).toBe(3);
  });

  it('isPosteLetterCode: 12 cifre o S10 internazionale, altri vettori no', () => {
    expect(isPosteLetterCode('698139123456')).toBe(true);
    expect(isPosteLetterCode('RR123456789IT')).toBe(true);
    expect(isPosteLetterCode('PSTAQ000000000000000')).toBe(false);
    expect(isPosteLetterCode('12345')).toBe(false);
  });

  it('posteTrackingUrl codifica il codice', () => {
    expect(posteTrackingUrl('698139123456')).toBe('https://www.poste.it/cerca/#/risultati-spedizioni/698139123456');
    expect(posteTrackingUrl('a b')).toContain('a%20b');
  });

  it('sendAttemptName', () => {
    expect(sendAttemptName(0, 1)).toBe('Recapito cartaceo');
    expect(sendAttemptName(0, 2)).toBe('Primo tentativo');
    expect(sendAttemptName(1, 2)).toBe('Secondo tentativo');
    expect(sendAttemptName(3, 4)).toBe('4° tentativo');
  });

  it('latestSendPosteLetter e sendPosteLetters ignorano i codici di altri vettori', () => {
    const tl = [
      { category: 'SEND_ANALOG_FEEDBACK', at: '2026-03-12T00:00:00.000Z', registeredLetterCode: '698139000002', attempt: 1 },
      { category: 'SEND_ANALOG_PROGRESS', at: '2026-03-11T00:00:00.000Z', registeredLetterCode: '698139000001', attempt: 0 },
      { category: 'SEND_ANALOG_PROGRESS', at: '2026-03-13T00:00:00.000Z', registeredLetterCode: 'PSTAQ000000000000000' },
    ];
    expect(latestSendPosteLetter(tl)).toBe('698139000002');
    expect(latestSendPosteLetter(null)).toBeNull();
    expect(sendPosteLetters(tl)).toEqual([
      { code: '698139000001', attempt: 0 },
      { code: '698139000002', attempt: 1 },
    ]);
  });
});

describe('Email consegnata', () => {
  const d = detail('EMAIL', [attempt()], {
    downloads: [{ channel: 'EMAIL', attachmentIndex: 0, downloadedAt: '2026-03-10T10:00:00.000Z' }],
  });

  it('percorso: invio e download del cittadino in ordine di tempo', () => {
    const events = buildJourney(d, labels);
    expect(events.map((e) => [e.source, e.title, e.tone])).toEqual([
      ['invio', 'Invio su Email', 'neutral'],
      ['cittadino', 'Documento scaricato', 'ok'],
    ]);
    expect(events[1]!.detail).toBe('Email');
  });

  it('verdetto: inviata e letta dopo il download', () => {
    const v = computeVerdict(d, labels);
    expect(v).toMatchObject({ headline: 'Inviata e letta', tone: 'ok', when: '2026-03-10T09:00:05.000Z', source: 'su Email', discrepancy: false });
    expect(v.note).toContain('Documento scaricato dal cittadino');
  });

  it('verdetto: solo inviata senza download', () => {
    expect(computeVerdict(detail('EMAIL', [attempt()]), labels)).toMatchObject({ headline: 'Inviata', tone: 'neutral', note: null });
  });

  it('invio fallito: verdetto ko con il messaggio d\'errore, evento con dettaglio', () => {
    const failed = detail('EMAIL', [attempt({ status: 'failed', errorMessage: 'Casella piena', sentAt: null })]);
    expect(computeVerdict(failed, labels)).toMatchObject({ headline: 'Invio non riuscito', tone: 'ko', note: 'Casella piena', source: 'su Email' });
    expect(buildJourney(failed, labels)[0]).toMatchObject({ tone: 'ko', detail: 'Casella piena' });
  });

  it('senza tentativi: "Non ancora inviata", oppure "Inviata" se il destinatario è sent', () => {
    expect(computeVerdict(detail('EMAIL', [], { recipient: { status: 'pending' } }), labels).headline).toBe('Non ancora inviata');
    expect(computeVerdict(detail('EMAIL', []), labels).headline).toBe('Inviata');
  });

  it('più tentativi: numerazione "Invio #n" e deduplica protocollo identico', () => {
    const proto = { protocolNumber: 42, protocolYear: 2026, protocolledAt: '2026-03-10T09:00:01.000Z' };
    const events = buildJourney(detail('EMAIL', [attempt({ ...proto }), attempt({ attemptNumber: 2, createdAt: '2026-03-11T09:00:00.000Z', ...proto })]), labels);
    expect(events.filter((e) => e.source === 'protocollo')).toHaveLength(1);
    expect(events.filter((e) => e.source === 'invio').map((e) => e.title)).toEqual(['Invio #1 su Email', 'Invio #2 su Email']);
  });
});

describe('SEND perfezionata', () => {
  const history = [
    { status: 'ACCEPTED', activeFrom: '2026-03-10T09:00:00.000Z' },
    { status: 'DELIVERING', activeFrom: '2026-03-11T09:00:00.000Z' },
    { status: 'EFFECTIVE_DATE', activeFrom: '2026-03-20T09:00:00.000Z' },
  ];
  const d = detail('SEND', [attempt({ channelType: 'SEND', sendStatus: 'EFFECTIVE_DATE', sendStatusUpdatedAt: '2026-04-01T00:00:00.000Z', sendStatusHistory: history })]);

  it('verdetto: stato PN con la data dallo storico, non dall\'ultimo sync', () => {
    expect(computeVerdict(d, labels)).toMatchObject({
      headline: 'SEND:EFFECTIVE_DATE',
      source: 'secondo SEND',
      when: '2026-03-20T09:00:00.000Z',
      entityLegalAt: '2026-03-10T09:00:00.000Z',
      undelivered: false,
      discrepancy: false,
    });
  });

  it('percorso: un evento per stato dello storico, toni coerenti', () => {
    const sendEvents = buildJourney(d, labels).filter((e) => e.source === 'send');
    expect(sendEvents.map((e) => [e.title, e.tone])).toEqual([
      ['SEND:ACCEPTED', 'neutral'],
      ['SEND:DELIVERING', 'neutral'],
      ['SEND:EFFECTIVE_DATE', 'ok'],
    ]);
  });

  it('irreperibile con perfezionamento: nota e undelivered', () => {
    const unreachable = detail('SEND', [attempt({
      channelType: 'SEND',
      sendStatus: 'EFFECTIVE_DATE',
      sendStatusHistory: [...history.slice(0, 2), { status: 'UNREACHABLE', activeFrom: '2026-03-15T09:00:00.000Z' }, history[2]!],
    })]);
    const v = computeVerdict(unreachable, labels);
    expect(v.undelivered).toBe(true);
    expect(v.note).toContain('irreperibile');
  });

  it('annullata: nessuna data legale per l\'ente', () => {
    const cancelled = detail('SEND', [attempt({ channelType: 'SEND', sendStatus: 'CANCELLED', sendStatusHistory: [history[0]!, { status: 'CANCELLED', activeFrom: '2026-03-12T09:00:00.000Z' }] })]);
    expect(computeVerdict(cancelled, labels)).toMatchObject({ entityLegalAt: null, undelivered: true });
  });

  it('senza storico: solo lo stato corrente, con la data dell\'ultimo sync', () => {
    const noHistory = detail('SEND', [attempt({ channelType: 'SEND', sendStatus: 'DELIVERING', sendStatusUpdatedAt: '2026-03-11T09:00:00.000Z' })]);
    const events = buildJourney(noHistory, labels).filter((e) => e.source === 'send');
    expect(events).toEqual([{ at: '2026-03-11T09:00:00.000Z', source: 'send', title: 'SEND:DELIVERING', tone: 'neutral' }]);
  });
});

describe('SEND con raccomandata Poste: blocchi e discrepanza', () => {
  const timeline = [
    { category: 'SEND_ANALOG_DOMICILE', at: '2026-03-12T08:00:00.000Z', attempt: 0, productType: 'AR' },
    { category: 'SEND_ANALOG_FEEDBACK', at: '2026-03-14T08:00:00.000Z', attempt: 0, code: 'RECRN001C', responseStatus: 'OK', registeredLetterCode: '698139123456' },
  ];
  const posteDelivered = {
    status: 'delivered' as const,
    trackingCode: '698139123456',
    nextCheckAt: null,
    lastCheckedAt: '2026-03-15T00:00:00.000Z',
    deliveredAt: '2026-03-14T07:00:00.000Z',
    movements: [{ at: '2026-03-14T07:00:00.000Z', luogo: 'Roma', statoLavorazione: 'Consegnata', box: '5', flagRitorno: false }],
  };

  it('il percorso raggruppa per tentativo e collega il tracking Poste', () => {
    const d = detail('SEND', [attempt({ channelType: 'SEND', sendStatus: 'DELIVERING', sendTimeline: timeline, posteVerifications: [posteDelivered] })]);
    const events = buildJourney(d, labels);
    const shipment = events.find((e) => e.title.startsWith('Affidata al recapitista'))!;
    expect(shipment.detail).toContain('Raccomandata n. 698139123456');
    expect(shipment.detail).toContain('recapitista Poste Italiane');
    expect(shipment.link).toEqual({ href: posteTrackingUrl('698139123456'), label: 'Traccia su poste.it' });
    expect(shipment.groupLabel).toBe('Recapito cartaceo · raccomandata n. 698139123456');
    const poste = events.find((e) => e.source === 'poste')!;
    expect(poste).toMatchObject({ title: 'Consegnata', tone: 'ok', groupLabel: 'Recapito cartaceo · raccomandata n. 698139123456' });
  });

  it('PN ancora in consegna ma Poste ha consegnato: discrepanza segnalata, esito legale resta di SEND', () => {
    const d = detail('SEND', [attempt({ channelType: 'SEND', sendStatus: 'DELIVERING', sendTimeline: timeline, posteVerification: posteDelivered })]);
    const v = computeVerdict(d, labels);
    expect(v.headline).toBe('SEND:DELIVERING');
    expect(v.discrepancy).toBe(true);
    expect(v.note).toContain('Poste: consegnata');
    expect(v.note).toContain('SEND non ha ancora ricevuto l\'esito');
  });
});

describe('POSTAL in giacenza', () => {
  const giacenza = attempt({
    channelType: 'POSTAL',
    postalStatus: 'InGiacenza',
    postalDeliveryStatus: 'Compiuta giacenza',
    postalStatusHistory: [
      { stato: 'Accettato', rilevatoIl: '2026-03-10T09:00:00.000Z' },
      { stato: 'InGiacenza', rilevatoIl: '2026-03-12T09:00:00.000Z', statoConsegna: 'Avviso di giacenza' },
    ],
  });

  it('percorso: stati GlobalCom con tono neutro', () => {
    const events = buildJourney(detail('POSTAL', [giacenza]), labels).filter((e) => e.source === 'globalcom');
    expect(events.map((e) => [e.title, e.detail, e.tone])).toEqual([
      ['GC:Accettato', null, 'neutral'],
      ['GC:InGiacenza', 'Avviso di giacenza', 'neutral'],
    ]);
  });

  it('verdetto senza esito legale: in lavorazione con stato GlobalCom in nota', () => {
    expect(computeVerdict(detail('POSTAL', [giacenza]), labels)).toMatchObject({
      headline: 'In lavorazione',
      tone: 'neutral',
      source: 'secondo GlobalCom',
      note: 'GC:InGiacenza (Compiuta giacenza)',
      discrepancy: false,
    });
  });

  it('esito legale in corso: stesso stato in nota, mai "Non consegnata"', () => {
    const d = detail('POSTAL', [giacenza], { legalOutcome: { outcome: 'in_progress', reason: null, at: null } });
    expect(computeVerdict(d, labels)).toMatchObject({ headline: 'In corso', note: 'GlobalCom: GC:InGiacenza (Compiuta giacenza)' });
  });

  it('esito legale consegnata per compiuta giacenza: consegna secondo GlobalCom', () => {
    const d = detail('POSTAL', [giacenza], { legalOutcome: { outcome: 'delivered', reason: 'Compiuta giacenza', at: '2026-03-25T00:00:00.000Z' } });
    expect(computeVerdict(d, labels)).toMatchObject({
      headline: 'Consegnata',
      tone: 'ok',
      when: '2026-03-25T00:00:00.000Z',
      source: 'secondo GlobalCom',
      note: 'Compiuta giacenza',
      dateOnly: true,
      discrepancy: false,
    });
  });

  it('esito legale non consegnata: undelivered', () => {
    const d = detail('POSTAL', [giacenza], { legalOutcome: { outcome: 'not_delivered', reason: 'Destinatario sconosciuto', at: null } });
    expect(computeVerdict(d, labels)).toMatchObject({ headline: 'Non consegnata', tone: 'ko', undelivered: true, note: 'Destinatario sconosciuto' });
  });

  it('Poste consegnata ma GlobalCom no: discrepanza con stato GlobalCom in nota', () => {
    const pv = { status: 'delivered' as const, trackingCode: '698139123456', nextCheckAt: null, lastCheckedAt: null, deliveredAt: '2026-03-14T07:00:00.000Z', outcomeAt: '2026-03-14T07:00:00.000Z', movements: [] };
    const d = detail('POSTAL', [attempt({ ...giacenza, posteVerification: pv })]);
    expect(computeVerdict(d, labels)).toMatchObject({
      headline: 'Consegnata',
      source: 'secondo Poste Italiane',
      when: '2026-03-14T07:00:00.000Z',
      discrepancy: true,
      note: 'GlobalCom: GC:InGiacenza (Compiuta giacenza)',
    });
  });
});
