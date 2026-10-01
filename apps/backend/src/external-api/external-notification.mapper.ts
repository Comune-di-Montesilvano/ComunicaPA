import { isPostalAgolService } from '@comunicapa/shared-types';
import type { CreateNotificationDto } from './dto/create-notification.dto.js';

/** Colonne extraData dedicate: physicalAddressConfig/paymentConfig puntano qui (stesso schema del self-bootstrap `_edit*` di updateRecipientAddressAndRetry). */
export const EXT_COLUMNS = {
  street: '_extStreet',
  zip: '_extZip',
  municipality: '_extMunicipality',
  province: '_extProvince',
  country: '_extCountry',
  noticeCode: '_extNoticeCode',
  amountCents: '_extAmountCents',
  dueDate: '_extDueDate',
} as const;

export interface MappedNotification {
  channelConfig: Record<string, unknown>;
  recipient: { codiceFiscale: string; fullName: string | null; email: string | null; pec: string | null; extraData: Record<string, string> };
}

/** Assegna solo se definito: un'opzione omessa resta assente e la strategy usa il proprio fallback. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

export function mapNotification(
  dto: CreateNotificationDto,
  defaults: { physicalCommunicationType?: string; postalServiceType?: string },
): MappedNotification {
  // `source: 'external'` sostituisce wizSingleMode (che faceva saltare il check INAD al lancio).
  const cfg: Record<string, unknown> = { source: 'external' };
  put(cfg, 'externalReference', dto.externalReference);
  cfg['subject'] = dto.content.subject;
  put(cfg, 'body', dto.content.body);

  put(cfg, 'mailConfigId', dto.sender?.mailConfigId);
  put(cfg, 'pecReserveMailConfigId', dto.sender?.pecReserveMailConfigId);
  put(cfg, 'ioServiceId', dto.sender?.ioServiceId);

  if (dto.appIoParallel) {
    cfg['secondaryChannels'] = [
      { channel: 'APP_IO', mode: 'parallel', subjectOverride: dto.appIoParallel.subject, bodyOverride: dto.appIoParallel.body },
    ];
  }

  if (dto.channel === 'SEND') {
    cfg['protocolla'] = true;
    cfg['taxonomyCode'] = dto.send!.taxonomyCode;
    put(cfg, 'physicalCommunicationType', defaults.physicalCommunicationType);
  }

  if (dto.channel === 'POSTAL') {
    const p = dto.postal ?? {};
    put(cfg, 'postalServiceType', defaults.postalServiceType);
    // Atto giudiziario: launch() (assertSendProtocolConfigured) lo rifiuta senza protocollazione.
    if (defaults.postalServiceType && isPostalAgolService(defaults.postalServiceType)) cfg['protocolla'] = true;
    put(cfg, 'postalCodiceContratto', p.contractCode);
    put(cfg, 'postalReturnReceipt', p.returnReceipt);
    put(cfg, 'postalColorPrint', p.color);
    put(cfg, 'postalDuplex', p.duplex);
    put(cfg, 'postalIdCoverPage', p.coverPageId);
    put(cfg, 'postalAgolTipoNotificante', p.agol?.notifierType);
    put(cfg, 'postalAgolSecondoTentativo', p.agol?.secondAttempt);
    put(cfg, 'postalAgolNomeNotificante', p.agol?.notifierName);
    put(cfg, 'postalAgolNumeroCronologico', p.agol?.chronologicalNumber);
  }

  const extraData: Record<string, string> = {};
  const a = dto.recipient.address;
  if (a) {
    cfg['physicalAddressConfig'] = {
      enabled: true,
      addressColumn: EXT_COLUMNS.street,
      zipColumn: EXT_COLUMNS.zip,
      municipalityColumn: EXT_COLUMNS.municipality,
      provinceColumn: EXT_COLUMNS.province,
      countryColumn: EXT_COLUMNS.country,
    };
    extraData[EXT_COLUMNS.street] = a.street.trim();
    extraData[EXT_COLUMNS.zip] = (a.zip ?? '').trim();
    extraData[EXT_COLUMNS.municipality] = a.municipality.trim();
    extraData[EXT_COLUMNS.province] = (a.province ?? '').trim().toUpperCase();
    extraData[EXT_COLUMNS.country] = (a.country ?? '').trim();
  }

  if (dto.payment) {
    cfg['paymentConfig'] = {
      enabled: true,
      amountType: 'cents',
      noticeNumberColumn: EXT_COLUMNS.noticeCode,
      amountColumn: EXT_COLUMNS.amountCents,
      payeeFiscalCodeType: 'static',
      payeeFiscalCodeStatic: dto.payment.creditorTaxId,
      ...(dto.payment.dueDate ? { dueDateColumn: EXT_COLUMNS.dueDate } : {}),
    };
    extraData[EXT_COLUMNS.noticeCode] = dto.payment.noticeCode;
    extraData[EXT_COLUMNS.amountCents] = String(dto.payment.amountCents);
    if (dto.payment.dueDate) extraData[EXT_COLUMNS.dueDate] = dto.payment.dueDate;
  }

  return {
    channelConfig: cfg,
    recipient: {
      codiceFiscale: dto.recipient.taxId.trim().toUpperCase(),
      fullName: dto.recipient.fullName?.trim() || null,
      email: dto.recipient.email?.trim() || null,
      pec: dto.recipient.pec?.trim() || null,
      extraData,
    },
  };
}
