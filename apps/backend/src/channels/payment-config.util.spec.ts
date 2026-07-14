import { resolvePaymentData, resolvePhysicalAddress } from './payment-config.util';
import type { Recipient } from '../entities/recipient.entity';

function makeRecipient(extraData: Record<string, unknown> = {}): Recipient {
  return {
    codiceFiscale: 'RSSMRA85M01H501Z',
    fullName: 'Mario Rossi',
    email: null,
    pec: null,
    extraData,
  } as unknown as Recipient;
}

describe('resolvePaymentData', () => {
  it('ritorna null se paymentConfig è undefined', () => {
    expect(resolvePaymentData(makeRecipient(), undefined)).toBeNull();
  });

  it('ritorna null se paymentConfig.enabled è false', () => {
    expect(resolvePaymentData(makeRecipient(), { enabled: false })).toBeNull();
  });

  it('risolve importo in euro, notice code, CF ente statico', () => {
    const recipient = makeRecipient({ importo: '120,50', avviso: '302000100000019421' });
    const result = resolvePaymentData(recipient, {
      enabled: true,
      amountColumn: 'importo',
      amountType: 'euro',
      noticeNumberColumn: 'avviso',
      payeeFiscalCodeType: 'static',
      payeeFiscalCodeStatic: '00223344556',
    });
    expect(result).toEqual({
      noticeCode: '302000100000019421',
      amountCents: 12050,
      creditorTaxId: '00223344556',
      dueDateIso: null,
    });
  });

  it('risolve importo in centesimi e CF ente da colonna', () => {
    const recipient = makeRecipient({ importo_cents: '5000', avviso: '111', cf_ente: '99988877766' });
    const result = resolvePaymentData(recipient, {
      enabled: true,
      amountColumn: 'importo_cents',
      amountType: 'cents',
      noticeNumberColumn: 'avviso',
      payeeFiscalCodeType: 'column',
      payeeFiscalCodeColumn: 'cf_ente',
    });
    expect(result).toEqual({
      noticeCode: '111',
      amountCents: 5000,
      creditorTaxId: '99988877766',
      dueDateIso: null,
    });
  });

  it('ritorna null se manca notice code o importo <= 0', () => {
    const recipient = makeRecipient({ importo: '0', avviso: '111' });
    const result = resolvePaymentData(recipient, {
      enabled: true,
      amountColumn: 'importo',
      amountType: 'euro',
      noticeNumberColumn: 'avviso',
      payeeFiscalCodeType: 'static',
      payeeFiscalCodeStatic: 'X',
    });
    expect(result).toBeNull();
  });

  it('risolve la data di scadenza se presente', () => {
    const recipient = makeRecipient({ importo: '10', avviso: '111', scadenza: '2026-12-31' });
    const result = resolvePaymentData(recipient, {
      enabled: true,
      amountColumn: 'importo',
      amountType: 'euro',
      noticeNumberColumn: 'avviso',
      payeeFiscalCodeType: 'static',
      payeeFiscalCodeStatic: 'X',
      dueDateColumn: 'scadenza',
    });
    expect(result?.dueDateIso).toBe('2026-12-31T23:59:59.000Z');
  });

  it('risolve la data di scadenza anche se notice code/importo non sono validi', () => {
    const recipient = makeRecipient({ importo: '0', scadenza: '2026-12-31' });
    const result = resolvePaymentData(recipient, {
      enabled: true,
      amountColumn: 'importo',
      amountType: 'euro',
      noticeNumberColumn: 'avviso', // colonna assente -> notice code vuoto
      payeeFiscalCodeType: 'static',
      payeeFiscalCodeStatic: 'X',
      dueDateColumn: 'scadenza',
    });
    expect(result).toEqual({
      noticeCode: null,
      amountCents: null,
      creditorTaxId: null,
      dueDateIso: '2026-12-31T23:59:59.000Z',
    });
  });
});

describe('resolvePhysicalAddress', () => {
  it('ritorna null se physicalAddressConfig è undefined', () => {
    expect(resolvePhysicalAddress(makeRecipient(), undefined)).toBeNull();
  });

  it('ritorna null se physicalAddressConfig.enabled è false', () => {
    expect(resolvePhysicalAddress(makeRecipient(), { enabled: false })).toBeNull();
  });

  it('risolve address/municipality/zip/province dalle colonne configurate', () => {
    const recipient = makeRecipient({
      indirizzo: 'Via Roma 1',
      comune: 'Comuneesempio',
      cap: '00000',
      prov: 'XX',
    });
    const result = resolvePhysicalAddress(recipient, {
      enabled: true,
      addressColumn: 'indirizzo',
      municipalityColumn: 'comune',
      zipColumn: 'cap',
      provinceColumn: 'prov',
    });
    expect(result).toEqual({
      address: 'Via Roma 1',
      municipality: 'Comuneesempio',
      zip: '00000',
      province: 'XX',
    });
  });

  it('ritorna null se manca address o municipality (entrambi obbligatori per PN)', () => {
    const recipient = makeRecipient({ indirizzo: 'Via Roma 1' });
    const result = resolvePhysicalAddress(recipient, {
      enabled: true,
      addressColumn: 'indirizzo',
      municipalityColumn: 'comune', // colonna assente
    });
    expect(result).toBeNull();
  });

  it('omette zip/province se non configurati o non risolti', () => {
    const recipient = makeRecipient({ indirizzo: 'Via Roma 1', comune: 'Roma' });
    const result = resolvePhysicalAddress(recipient, {
      enabled: true,
      addressColumn: 'indirizzo',
      municipalityColumn: 'comune',
    });
    expect(result).toEqual({ address: 'Via Roma 1', municipality: 'Roma' });
  });
});
