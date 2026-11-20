import {
  buildMaggioliMancateTxt,
  buildMaggioliNotificheTxt,
  maggioliFromPostal,
  maggioliFromSend,
  sendDeliveryKind,
  sendRegisteredLetterOf,
  protocolOf,
  fitProtocol,
  maggioliOcr,
} from './maggioli-export.util.js';
import type { PostalReportRowDto, SendReportRowDto } from './dto/campaign-stats.dto.js';

const OCR18 = '123456789012345678';

function postal(over: Partial<PostalReportRowDto>): PostalReportRowDto {
  return {
    codiceFiscale: 'RSSMRA80A01H501U', fullName: 'Mario Rossi', postalTrackingId: 'IDPRO1', postalStatus: 'Consegnato',
    postalStatusHistory: [{ stato: 'Accettato', rilevatoIl: '2026-05-01T08:00:00.000Z' }],
    address: '', municipality: '', foreignState: '', codiceErrore: null, descrizioneErrore: null, appIoOutcome: null,
    externalId: OCR18, posteVerification: null, posteDiscrepancy: false,
    legalOutcome: 'delivered', legalOutcomeReason: 'Consegnato a Domicilio', legalOutcomeAt: '2026-05-14T10:00:00.000Z',
    postalAcceptanceId: '614451234567', postalDeliveryStatus: 'Consegnato a Domicilio', postalDeliveryDate: '2026-05-14T10:00:00.000Z',
    sentAt: '2026-05-02T09:00:00.000Z', protocol: null,
    ...over,
  };
}

function send(over: Partial<SendReportRowDto>): SendReportRowDto {
  return {
    codiceFiscale: 'RSSMRA80A01H501U', fullName: 'Mario Rossi', iun: 'IUN-1', digitalDomicileType: null, digitalDomicileAddress: null,
    sendStatus: 'EFFECTIVE_DATE', address: '', municipality: '', foreignState: '', appIoOutcome: null, externalId: OCR18,
    sendDeliveryKind: null, sendRegisteredLetterCode: null, protocol: null,
    sendStatusHistory: [
      { status: 'ACCEPTED', activeFrom: '2026-05-01T08:00:00Z' },
      { status: 'EFFECTIVE_DATE', activeFrom: '2026-05-12T22:30:00Z' },
    ],
    ...over,
  };
}

describe('maggioliOcr', () => {
  it('primi 16 caratteri (OCR senza i 2 di controllo), separatori ignorati; troppo corto → null', () => {
    expect(maggioliOcr(OCR18)).toBe('1234567890123456');
    expect(maggioliOcr('1234 5678 9012 3456')).toBe('1234567890123456');
    expect(maggioliOcr('123')).toBeNull();
    expect(maggioliOcr(null)).toBeNull();
  });
});

describe('tracciato Notifiche (64 caratteri)', () => {
  it('record con posizioni del tracciato Service Maggioli', () => {
    const exp = maggioliFromPostal([postal({})]);
    const [line] = buildMaggioliNotificheTxt(exp.notifiche).split('\n');
    expect(line).toHaveLength(64);
    expect(line[0]).toBe('B');
    expect(line.slice(1, 11)).toBe('14/05/2026');
    expect(line.slice(11, 23)).toBe('614451234567');
    expect(line.slice(23, 25)).toBe('NA');
    expect(line.slice(25, 41)).toBe('1234567890123456');
    expect(line.slice(41, 51)).toBe(' '.repeat(10));
    expect(line.slice(51, 63)).toBe('RACC        ');
    expect(line[63]).toBe('A');
  });

  it('data nel fuso italiano (23:30 UTC = giorno dopo a Roma)', () => {
    const exp = maggioliFromSend([send({})]);
    expect(buildMaggioliNotificheTxt(exp.notifiche).slice(1, 11)).toBe('13/05/2026');
  });

  it('compiuta giacenza e dirottato PEC vanno tra le notifiche; PEC senza raccomandata', () => {
    const exp = maggioliFromPostal([
      postal({ legalOutcomeReason: 'Compiuta Giacenza', postalDeliveryStatus: 'Compiuta Giacenza' }),
      postal({ legalOutcomeReason: 'Via PEC', postalAcceptanceId: null }),
    ]);
    expect(exp.notifiche).toHaveLength(2);
    expect(exp.notifiche[1]).toMatchObject({ raccomandata: null, canale: 'PEC' });
  });
});

describe('tracciato Mancate notifiche (150 caratteri)', () => {
  it('POSTAL restituita: codice dalla causale GlobalCom, date emissione e mancata', () => {
    const exp = maggioliFromPostal([postal({
      legalOutcome: 'not_delivered', legalOutcomeReason: 'Destinatario irreperibile', legalOutcomeAt: null,
      postalDeliveryStatus: 'Destinatario irreperibile', postalDeliveryDate: '2026-05-20T10:00:00.000Z',
    })]);
    expect(exp.notifiche).toHaveLength(0);
    const [line] = buildMaggioliMancateTxt(exp.mancate).split('\n');
    expect(line).toHaveLength(150);
    expect(line.slice(0, 2)).toBe('01');
    expect(line.slice(2, 14)).toBe('614451234567');
    expect(line.slice(14, 26)).toBe('614451234567');
    expect(line.slice(26, 42)).toBe('1234567890123456');
    expect(line.slice(42, 44)).toBe(' 4');
    expect(line.slice(44, 54)).toBe('02/05/2026');
    expect(line.slice(54, 64)).toBe('20/05/2026');
    expect(line.slice(64, 80)).toBe('RACC'.padEnd(16));
    expect(line.slice(80)).toBe(' '.repeat(70));
  });

  it('causale non mappata → " N"; deceduto → " 5"', () => {
    const base = { legalOutcome: 'not_delivered' as const, legalOutcomeAt: null };
    const exp = maggioliFromPostal([
      postal({ ...base, postalDeliveryStatus: 'Smarrito' }),
      postal({ ...base, postalDeliveryStatus: 'Destinatario deceduto' }),
    ]);
    expect(exp.mancate.map((m) => m.tipo)).toEqual([' N', ' 5']);
  });

  it('SEND irreperibile non perfezionata → " 4", data emissione = presa in carico', () => {
    const exp = maggioliFromSend([send({ sendStatusHistory: [
      { status: 'ACCEPTED', activeFrom: '2026-05-01T08:00:00Z' },
      { status: 'UNREACHABLE', activeFrom: '2026-05-10T08:00:00Z' },
    ] })]);
    const [line] = buildMaggioliMancateTxt(exp.mancate).split('\n');
    expect(line.slice(2, 26)).toBe(' '.repeat(24));
    expect(line.slice(64, 80)).toBe('SEND RACC'.padEnd(16));
    expect(line.slice(42, 44)).toBe(' 4');
    expect(line.slice(44, 64)).toBe('01/05/202610/05/2026');
  });
});

describe('esclusi', () => {
  it('in corso, errori GlobalCom e annullate SEND: non esportabili; senza OCR: contati a parte', () => {
    const p = maggioliFromPostal([
      postal({ legalOutcome: 'in_progress', legalOutcomeAt: null }),
      postal({ legalOutcome: 'not_delivered', legalOutcomeAt: null, postalDeliveryStatus: null, postalStatus: 'Errore' }),
      postal({ externalId: null }),
    ]);
    expect(p).toMatchObject({ notifiche: [], mancate: [], nonEsportabili: 2, senzaOcr: 1 });
    // OCR mancante contato su tutti i destinatari, anche senza esito.
    expect(maggioliFromPostal([postal({ externalId: null, legalOutcome: 'not_delivered', postalDeliveryStatus: null }), postal({})]).ocrMancanti).toBe(1);
    expect(maggioliFromSend([send({ externalId: '614451234567' }), send({})]).ocrMancanti).toBe(1);
    const s = maggioliFromSend([send({ sendStatusHistory: [{ status: 'CANCELLED', activeFrom: '2026-05-01T08:00:00Z' }] })]);
    expect(s).toMatchObject({ notifiche: [], mancate: [], nonEsportabili: 1 });
  });
});

describe('canale SEND nei campi note', () => {
  const ACC = { status: 'ACCEPTED', activeFrom: '2026-05-01T08:00:00Z' };
  const VIEWED = { status: 'VIEWED', activeFrom: '2026-05-03T08:00:00Z' };
  const EFFECTIVE = { status: 'EFFECTIVE_DATE', activeFrom: '2026-05-12T08:00:00Z' };

  it('letta prima del perfezionamento: IO con cortesia App IO, RADD allo sportello, altrimenti WEB', () => {
    expect(sendDeliveryKind([ACC, VIEWED], [{ category: 'SEND_COURTESY_MESSAGE', at: '2026-05-01T09:00:00Z', channel: 'APPIO' }], null)).toBe('IO');
    expect(sendDeliveryKind([ACC, VIEWED], [{ category: 'NOTIFICATION_VIEWED', at: '2026-05-03T08:00:00Z', raddType: 'ALT' }], null)).toBe('RADD');
    expect(sendDeliveryKind([ACC, VIEWED], [{ category: 'SEND_COURTESY_MESSAGE', at: '2026-05-01T09:00:00Z', channel: 'EMAIL' }], 'PEC')).toBe('WEB');
  });

  it('perfezionata per decorrenza: PEC da domicilio digitale, RACC da recapitista (vince sul fallback cartaceo)', () => {
    expect(sendDeliveryKind([ACC, EFFECTIVE], [{ category: 'SEND_DIGITAL_DOMICILE', at: '2026-05-01T09:00:00Z', channel: 'PEC' }], 'PEC')).toBe('PEC');
    expect(sendDeliveryKind([ACC, EFFECTIVE], [
      { category: 'SEND_DIGITAL_DOMICILE', at: '2026-05-01T09:00:00Z', channel: 'PEC' },
      { category: 'SEND_ANALOG_DOMICILE', at: '2026-05-05T09:00:00Z' },
    ], 'CARTACEO')).toBe('RACC');
    // Letta DOPO il perfezionamento: conta il perfezionamento.
    expect(sendDeliveryKind([ACC, EFFECTIVE, { status: 'VIEWED', activeFrom: '2026-05-20T08:00:00Z' }], [], 'PEC')).toBe('PEC');
    expect(sendDeliveryKind([ACC, { status: 'UNREACHABLE', activeFrom: '2026-05-10T08:00:00Z' }], [], null)).toBe('RACC');
    expect(sendDeliveryKind([ACC], [], null)).toBeNull();
  });

  it('ultima raccomandata del recapitista', () => {
    expect(sendRegisteredLetterOf([
      { category: 'SEND_ANALOG_PROGRESS', at: '2026-05-05T09:00:00Z', registeredLetterCode: 'RA111111111IT' },
      { category: 'SEND_ANALOG_PROGRESS', at: '2026-05-08T09:00:00Z', registeredLetterCode: '614451234567' },
    ])).toBe('614451234567');
    expect(sendRegisteredLetterOf(null)).toBeNull();
  });

  it('protocollo troppo lungo: anno a 2 cifre', () => {
    expect(fitProtocol('123456/2026', 12)).toBe('123456/2026');
    expect(fitProtocol('1234567/2026', 12)).toBe('1234567/2026');
    expect(fitProtocol('12345678/2026', 12)).toBe('12345678/26');
    expect(fitProtocol(null, 12)).toBeNull();
    const [line] = buildMaggioliNotificheTxt(maggioliFromSend([send({ sendDeliveryKind: 'PEC', protocol: '12345678/2026' })]).notifiche).split('
');
    expect(line.slice(11, 23)).toBe('12345678/26 ');
  });

  it('protocollo n/anno del tentativo protocollato più recente', () => {
    expect(protocolOf([
      { attemptNumber: 1, protocolNumber: 10, protocolYear: 2026 },
      { attemptNumber: 2, protocolNumber: null },
      { attemptNumber: 3, protocolNumber: 12345, protocolYear: 2026 },
    ])).toBe('12345/2026');
    expect(protocolOf([null, { attemptNumber: 1, protocolNumber: null }])).toBeNull();
  });

  it('notifiche: raccomandata o protocollo in 12-23, canale nelle note (52-63)', () => {
    const exp = maggioliFromSend([
      send({ sendDeliveryKind: 'RACC', sendRegisteredLetterCode: '614451234567', protocol: '12345/2026' }),
      send({ sendDeliveryKind: 'PEC', sendRegisteredLetterCode: '614451234567', protocol: '12345/2026' }),
      send({ sendDeliveryKind: 'IO' }),
    ]);
    const [racc, pec, io] = buildMaggioliNotificheTxt(exp.notifiche).split('\n');
    expect(racc.slice(11, 23)).toBe('614451234567');
    expect(racc.slice(51, 63)).toBe('SEND RACC   ');
    expect(pec.slice(11, 23)).toBe('12345/2026  ');
    expect(pec.slice(51, 63)).toBe('SEND PEC    ');
    expect(io.slice(11, 23)).toBe(' '.repeat(12));
    expect(io.slice(51, 63)).toBe('SEND APPIO  ');
    expect(racc.slice(41, 49)).toBe(' '.repeat(8));
    expect(racc).toHaveLength(64);
    const postale = buildMaggioliNotificheTxt(maggioliFromPostal([postal({})]).notifiche);
    expect(postale.slice(51, 63)).toBe('RACC        ');
  });

  it('mancate: raccomandata o protocollo (3-26), canale (65-80), protocollo nel lotto (81-95)', () => {
    const exp = maggioliFromSend([send({ protocol: '7/2026', sendStatusHistory: [ACC, { status: 'RETURNED_TO_SENDER', activeFrom: '2026-05-10T08:00:00Z' }] })]);
    const [line] = buildMaggioliMancateTxt(exp.mancate).split('\n');
    expect(line.slice(2, 14)).toBe('7/2026      ');
    expect(line.slice(14, 26)).toBe('7/2026      ');
    expect(line.slice(64, 80)).toBe('SEND RACC'.padEnd(16));
    expect(line.slice(80, 95)).toBe('7/2026'.padEnd(15));
    expect(line).toHaveLength(150);
    const conRacc = maggioliFromPostal([postal({ legalOutcome: 'not_delivered', legalOutcomeAt: null, postalDeliveryStatus: 'Destinatario sconosciuto', protocol: '99/2026' })]);
    const [l2] = buildMaggioliMancateTxt(conRacc.mancate).split('\n');
    expect(l2.slice(2, 14)).toBe('614451234567');
    expect(l2.slice(64, 80)).toBe('RACC'.padEnd(16));
    expect(l2.slice(80, 95)).toBe('99/2026'.padEnd(15));
    const pec = maggioliFromPostal([postal({ legalOutcomeReason: 'Via PEC', postalAcceptanceId: null, protocol: '99/2026' })]);
    expect(pec.notifiche[0]).toMatchObject({ raccomandata: '99/2026', canale: 'PEC' });
  });
});
