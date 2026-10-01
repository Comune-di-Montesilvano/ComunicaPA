import { Injectable } from '@nestjs/common';
import {
  isPostalAgolService,
  postalServiceSupportsReturnReceipt,
  POSTAL_AGOL_NOTIFIER_TYPES,
  POSTAL_AGOL_SECOND_ATTEMPT_OPTIONS,
  SEND_PHYSICAL_COMMUNICATION_TYPES,
  SEND_TAXONOMY_CATALOG,
  sendTaxonomyRequiresPayment,
} from '@comunicapa/shared-types';
import { MailConfigsService } from '../mail-configs/mail-configs.service.js';
import { IoServicesService } from '../io-services/io-services.service.js';
import { PostalProvidersService } from '../postal-providers/postal-providers.service.js';
import { AppSettingsService } from '../settings/app-settings.service.js';
import type { SettingKey } from '../settings/settings.registry.js';
import type { ValidationIssue } from './external-api.error.js';
import { APP_IO_LIMITS, type CreateNotificationDto } from './dto/create-notification.dto.js';
import { MAX_CHUNK_SIZE_BYTES } from '../campaigns/chunked-upload.util.js';

export interface SenderCapability { id: string; name: string; fromAddress: string; default: boolean }
export interface TaxonomyCapability { code: string; label: string; description: string; requiresPayment: boolean; default: boolean }
export interface PostalServiceCapability { value: string; returnReceiptAvailable: boolean; agol: boolean; default: boolean }

export interface CapabilitiesResponse {
  success: true;
  recipientTypes: ['PF', 'PG'];
  limits: {
    attachment: { chunkMaxBytes: number; chunkRecommendedBytes: number; tokenTtlHours: number };
    appIo: { subject: readonly [number, number]; body: readonly [number, number] };
    idempotencyKeyTtlHours: number;
  };
  channels: {
    EMAIL: { active: boolean; senders: SenderCapability[] };
    PEC: { active: boolean; senders: SenderCapability[] };
    APP_IO: { active: boolean; services: Array<{ id: string; name: string; default: boolean }>; parallelAvailable: boolean };
    SEND: {
      active: boolean;
      environment: string;
      taxonomies: TaxonomyCapability[];
      physicalCommunicationTypes: Array<{ value: string; default: boolean }>;
    };
    POSTAL: {
      active: boolean;
      serviceTypes: PostalServiceCapability[];
      contracts: Array<{ code: string; description: string; type: string; foreign: boolean }>;
      defaults: { color: boolean; duplex: boolean; returnReceipt: boolean };
      agol: { notifierTypes: string[]; secondAttemptOptions: string[] };
    };
  };
}

export const IDEMPOTENCY_TTL_HOURS = 24;

/**
 * Unica fonte per /capabilities E per la validazione dinamica di POST
 * /notifications: un valore accettato in creazione è per costruzione uno di
 * quelli esposti qui, mai due liste che divergono.
 */
@Injectable()
export class ExternalCapabilitiesService {
  constructor(
    private readonly mailConfigs: MailConfigsService,
    private readonly ioServices: IoServicesService,
    private readonly postalProviders: PostalProvidersService,
    private readonly settings: AppSettingsService,
  ) {}

  async getCapabilities(): Promise<CapabilitiesResponse> {
    const [emailList, pecList, ioList, ioKey, postal, taxonomyRaw, sendEnv] = await Promise.all([
      this.mailConfigs.listMasked('EMAIL'),
      this.mailConfigs.listMasked('PEC'),
      this.ioServices.listMasked(),
      this.ioServices.resolveApiKey(),
      this.postalProviders.getActive(),
      this.settings.get<string>('send.enabledTaxonomyCodes'),
      this.settings.get<string>('send.environment'),
    ]);

    const toSender = (c: { id: string; name: string; fromAddress: string; isDefault: boolean }): SenderCapability => ({
      id: c.id, name: c.name, fromAddress: c.fromAddress, default: c.isDefault,
    });
    const emailSenders = emailList.filter((c) => c.active).map(toSender);
    const pecSenders = pecList.filter((c) => c.active).map(toSender);

    // Stesso ambiente/prefisso di SendDispatchService.dispatchOne().
    const prefix = `send.${sendEnv === 'produzione' ? 'prod' : 'test'}`;
    const [sendApiKey, sendPurposeId] = await Promise.all([
      this.settings.get<string>(`${prefix}.apiKey` as SettingKey),
      this.settings.get<string>(`${prefix}.purposeId` as SettingKey),
    ]);
    const sendActive = !!sendApiKey && !!sendPurposeId;

    const appIoActive = ioKey !== null;
    const serviceTypes = postal?.enabledServiceTypes ?? [];

    return {
      success: true,
      recipientTypes: ['PF', 'PG'],
      limits: {
        attachment: { chunkMaxBytes: MAX_CHUNK_SIZE_BYTES, chunkRecommendedBytes: 512 * 1024, tokenTtlHours: 24 },
        appIo: { subject: APP_IO_LIMITS.subject, body: APP_IO_LIMITS.body },
        idempotencyKeyTtlHours: IDEMPOTENCY_TTL_HOURS,
      },
      channels: {
        EMAIL: { active: emailSenders.length > 0, senders: emailSenders },
        PEC: { active: pecSenders.length > 0, senders: pecSenders },
        APP_IO: {
          active: appIoActive,
          services: appIoActive ? ioList.map((s) => ({ id: s.id, name: s.nome, default: s.isDefault })) : [],
          parallelAvailable: appIoActive,
        },
        SEND: {
          active: sendActive,
          environment: sendEnv || 'test',
          taxonomies: sendActive ? parseTaxonomies(taxonomyRaw) : [],
          physicalCommunicationTypes: SEND_PHYSICAL_COMMUNICATION_TYPES.map((value, i) => ({ value, default: i === 0 })),
        },
        POSTAL: {
          active: postal !== null && postal !== undefined,
          serviceTypes: serviceTypes.map((value, i) => ({
            value,
            returnReceiptAvailable: postalServiceSupportsReturnReceipt(value),
            agol: isPostalAgolService(value),
            default: i === 0,
          })),
          contracts: (postal?.contratti ?? []).map((c) => ({ code: c.codiceContratto, description: c.descrizione, type: c.tipologia, foreign: c.estero })),
          // Stessi fallback runtime di postal.strategy.ts (colore off, fronte/retro on, AR off).
          defaults: { color: false, duplex: true, returnReceipt: false },
          agol: { notifierTypes: [...POSTAL_AGOL_NOTIFIER_TYPES], secondAttemptOptions: [...POSTAL_AGOL_SECOND_ATTEMPT_OPTIONS] },
        },
      },
    };
  }

  validate(dto: CreateNotificationDto, caps: CapabilitiesResponse): { inactiveChannel: boolean; issues: ValidationIssue[] } {
    if (!caps.channels[dto.channel]?.active) return { inactiveChannel: true, issues: [] };
    const issues: ValidationIssue[] = [];

    if (dto.channel === 'SEND' && dto.send) {
      const allowed = caps.channels.SEND.taxonomies.map((t) => t.code);
      const code = dto.send.taxonomyCode;
      if (!allowed.includes(code)) {
        issues.push({ field: 'send.taxonomyCode', message: 'taxonomyCode non abilitato su questa istanza', allowed });
      } else if (sendTaxonomyRequiresPayment(code) !== !!dto.payment) {
        issues.push({
          field: 'send.taxonomyCode',
          message: dto.payment ? 'con payment serve un taxonomyCode con suffisso P' : 'un taxonomyCode con suffisso P richiede payment',
          allowed: caps.channels.SEND.taxonomies.filter((t) => t.requiresPayment === !!dto.payment).map((t) => t.code),
        });
      }
    }

    if (dto.channel === 'POSTAL' && dto.postal) {
      const services = caps.channels.POSTAL.serviceTypes;
      const st = dto.postal.serviceType;
      if (st !== undefined && !services.some((s) => s.value === st)) {
        issues.push({ field: 'postal.serviceType', message: 'serviceType non abilitato', allowed: services.map((s) => s.value) });
      }
      const contracts = caps.channels.POSTAL.contracts.map((c) => c.code);
      if (dto.postal.contractCode !== undefined && !contracts.includes(dto.postal.contractCode)) {
        issues.push({ field: 'postal.contractCode', message: 'contractCode non disponibile', allowed: contracts });
      }
      const effective = st ?? services.find((s) => s.default)?.value;
      if (dto.postal.returnReceipt && effective && !postalServiceSupportsReturnReceipt(effective)) {
        issues.push({ field: 'postal.returnReceipt', message: `ricevuta di ritorno non disponibile per il servizio ${effective}` });
      }
    }

    const s = dto.sender;
    if (s?.mailConfigId !== undefined) {
      const list = dto.channel === 'PEC' ? caps.channels.PEC.senders : caps.channels.EMAIL.senders;
      if (!list.some((x) => x.id === s.mailConfigId)) {
        issues.push({ field: 'sender.mailConfigId', message: 'mittente non disponibile per il canale', allowed: list.map((x) => x.id) });
      }
    }
    if (s?.pecReserveMailConfigId !== undefined && !caps.channels.PEC.senders.some((x) => x.id === s.pecReserveMailConfigId)) {
      issues.push({ field: 'sender.pecReserveMailConfigId', message: 'mittente PEC non disponibile', allowed: caps.channels.PEC.senders.map((x) => x.id) });
    }
    if (s?.ioServiceId !== undefined && !caps.channels.APP_IO.services.some((x) => x.id === s.ioServiceId)) {
      issues.push({ field: 'sender.ioServiceId', message: 'servizio App IO non disponibile', allowed: caps.channels.APP_IO.services.map((x) => x.id) });
    }
    if (dto.appIoParallel && !caps.channels.APP_IO.parallelAvailable) {
      issues.push({ field: 'appIoParallel', message: 'App IO non configurato su questa istanza' });
    }
    return { inactiveChannel: false, issues };
  }

  resolveDefaults(dto: CreateNotificationDto, caps: CapabilitiesResponse): { physicalCommunicationType?: string; postalServiceType?: string } {
    if (dto.channel === 'SEND') {
      return { physicalCommunicationType: dto.send?.physicalCommunicationType ?? caps.channels.SEND.physicalCommunicationTypes.find((t) => t.default)!.value };
    }
    if (dto.channel === 'POSTAL') {
      const def = caps.channels.POSTAL.serviceTypes.find((s) => s.default)?.value;
      return { postalServiceType: dto.postal?.serviceType ?? def };
    }
    return {};
  }
}

/** Setting `send.enabledTaxonomyCodes`: `{code,label,isDefault}[]` (UI attuale) o `string[]` (formato storico). */
function parseTaxonomies(raw: string | undefined): TaxonomyCapability[] {
  let list: Array<string | { code: string; label?: string; isDefault?: boolean }>;
  try {
    list = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  const rows = list.map((e) => (typeof e === 'string' ? { code: e, label: '', isDefault: false } : { code: e.code, label: e.label ?? '', isDefault: !!e.isDefault }));
  const hasDefault = rows.some((r) => r.isDefault);
  return rows.map((r, i) => {
    const entry = SEND_TAXONOMY_CATALOG.find((t) => t.code === r.code);
    return {
      code: r.code,
      label: r.label || entry?.title || r.code,
      description: entry?.description ?? '',
      requiresPayment: sendTaxonomyRequiresPayment(r.code),
      default: hasDefault ? r.isDefault : i === 0,
    };
  });
}
