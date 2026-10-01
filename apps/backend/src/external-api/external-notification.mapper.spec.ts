import { mapNotification, EXT_COLUMNS } from './external-notification.mapper.js';
import type { CreateNotificationDto } from './dto/create-notification.dto.js';

const ADDRESS = { street: 'Via Roma 1', zip: '00100', municipality: 'Roma', province: 'RM' };

describe('mapNotification', () => {
  it('EMAIL: subject/body, sender, App IO parallela, source external, mai wizSingleMode', () => {
    const m = mapNotification(
      {
        channel: 'EMAIL',
        externalReference: 'PROT-1',
        recipient: { type: 'PF', taxId: 'rssmra80a01h501u', email: 'a@b.it' },
        content: { subject: 'Avviso', body: '<p>x</p>' },
        sender: { mailConfigId: '11111111-1111-4111-8111-111111111111' },
        appIoParallel: { subject: 'Hai una comunicazione' },
      } as CreateNotificationDto,
      {},
    );
    expect(m.channelConfig).toEqual({
      source: 'external',
      externalReference: 'PROT-1',
      subject: 'Avviso',
      body: '<p>x</p>',
      mailConfigId: '11111111-1111-4111-8111-111111111111',
      secondaryChannels: [{ channel: 'APP_IO', mode: 'parallel', subjectOverride: 'Hai una comunicazione', bodyOverride: undefined }],
    });
    expect(m.channelConfig).not.toHaveProperty('wizSingleMode');
    expect(m.recipient).toEqual({ codiceFiscale: 'RSSMRA80A01H501U', fullName: null, email: 'a@b.it', pec: null, extraData: {} });
  });

  it('SEND: tassonomia, tipo comunicazione, protocolla true, indirizzo e pagamento su colonne _ext*', () => {
    const m = mapNotification(
      {
        channel: 'SEND',
        recipient: { type: 'PG', taxId: '01234567890', fullName: 'ACME SRL', address: ADDRESS },
        content: { subject: 'Notifica atto' },
        attachments: [{ token: '3fbb1e2a-1234-4abc-9def-426614174000' }],
        payment: { noticeCode: '302000000000000000', amountCents: 12300, creditorTaxId: '01234567890', dueDate: '2026-12-31' },
        send: { taxonomyCode: '010101P' },
      } as CreateNotificationDto,
      { physicalCommunicationType: 'AR_REGISTERED_LETTER' },
    );
    expect(m.channelConfig).toEqual({
      source: 'external',
      subject: 'Notifica atto',
      protocolla: true,
      taxonomyCode: '010101P',
      physicalCommunicationType: 'AR_REGISTERED_LETTER',
      physicalAddressConfig: {
        enabled: true,
        addressColumn: EXT_COLUMNS.street,
        zipColumn: EXT_COLUMNS.zip,
        municipalityColumn: EXT_COLUMNS.municipality,
        provinceColumn: EXT_COLUMNS.province,
        countryColumn: EXT_COLUMNS.country,
      },
      paymentConfig: {
        enabled: true,
        amountType: 'cents',
        noticeNumberColumn: EXT_COLUMNS.noticeCode,
        amountColumn: EXT_COLUMNS.amountCents,
        payeeFiscalCodeType: 'static',
        payeeFiscalCodeStatic: '01234567890',
        dueDateColumn: EXT_COLUMNS.dueDate,
      },
    });
    expect(m.recipient).toEqual({
      codiceFiscale: '01234567890',
      fullName: 'ACME SRL',
      email: null,
      pec: null,
      extraData: {
        _extStreet: 'Via Roma 1',
        _extZip: '00100',
        _extMunicipality: 'Roma',
        _extProvince: 'RM',
        _extCountry: '',
        _extNoticeCode: '302000000000000000',
        _extAmountCents: '12300',
        _extDueDate: '2026-12-31',
      },
    });
  });

  it('POSTAL: tutte le opzioni, Agol, servizio di default', () => {
    const m = mapNotification(
      {
        channel: 'POSTAL',
        recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address: { ...ADDRESS, province: 'rm' } },
        content: { subject: 'Avviso' },
        attachments: [{ token: '3fbb1e2a-1234-4abc-9def-426614174000' }],
        postal: {
          contractCode: 'C1', returnReceipt: true, color: true, duplex: false, coverPageId: 'CP1',
          agol: { notifierType: 'Procuratore', secondAttempt: 'Automatico', notifierName: 'ROSSI MARIO', chronologicalNumber: '42' },
        },
      } as CreateNotificationDto,
      { postalServiceType: 'AgolRaccomandata' },
    );
    expect(m.channelConfig).toEqual(expect.objectContaining({
      postalServiceType: 'AgolRaccomandata',
      postalCodiceContratto: 'C1',
      postalReturnReceipt: true,
      postalColorPrint: true,
      postalDuplex: false,
      postalIdCoverPage: 'CP1',
      postalAgolTipoNotificante: 'Procuratore',
      postalAgolSecondoTentativo: 'Automatico',
      postalAgolNomeNotificante: 'ROSSI MARIO',
      postalAgolNumeroCronologico: '42',
    }));
    // Atto giudiziario (Agol): launch() rifiuta senza protocollazione, come per SEND.
    expect(m.channelConfig).toHaveProperty('protocolla', true);
    expect(m.recipient.extraData._extProvince).toBe('RM');
  });

  it('POSTAL Agol dal servizio di default → protocolla true; servizio non Agol → nessuna protocollazione', () => {
    const base = {
      channel: 'POSTAL',
      recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address: ADDRESS },
      content: { subject: 'Avviso' },
      attachments: [{ token: '3fbb1e2a-1234-4abc-9def-426614174000' }],
    } as CreateNotificationDto;
    expect(mapNotification(base, { postalServiceType: 'AgolMarket' }).channelConfig).toHaveProperty('protocolla', true);
    expect(mapNotification(base, { postalServiceType: 'RaccomandataMarket4' }).channelConfig).not.toHaveProperty('protocolla');
  });

  it('opzioni postali omesse → chiavi assenti (fallback runtime della strategy)', () => {
    const m = mapNotification(
      {
        channel: 'POSTAL',
        recipient: { type: 'PF', taxId: 'RSSMRA80A01H501U', fullName: 'ROSSI MARIO', address: ADDRESS },
        content: { subject: 'Avviso' },
        attachments: [{ token: '3fbb1e2a-1234-4abc-9def-426614174000' }],
      } as CreateNotificationDto,
      { postalServiceType: 'Raccomandata' },
    );
    for (const k of ['postalCodiceContratto', 'postalReturnReceipt', 'postalColorPrint', 'postalDuplex', 'postalIdCoverPage', 'postalAgolTipoNotificante']) {
      expect(m.channelConfig).not.toHaveProperty(k);
    }
  });
});
