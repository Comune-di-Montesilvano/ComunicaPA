import {
  buildMaggioliMancateTxt,
  buildMaggioliNotificheTxt,
  maggioliFromPostal,
  maggioliFromSend,
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
    sentAt: '2026-05-02T09:00:00.000Z',
    ...over,
  };
}

function send(over: Partial<SendReportRowDto>): SendReportRowDto {
  return {
    codiceFiscale: 'RSSMRA80A01H501U', fullName: 'Mario Rossi', iun: 'IUN-1', digitalDomicileType: null, digitalDomicileAddress: null,
    sendStatus: 'EFFECTIVE_DATE', address: '', municipality: '', foreignState: '', appIoOutcome: null, externalId: OCR18,
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
    expect(line.slice(51, 63)).toBe('614451234567');
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
    expect(exp.notifiche[1].raccomandata).toBeNull();
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
    expect(line.slice(64)).toBe(' '.repeat(86));
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
