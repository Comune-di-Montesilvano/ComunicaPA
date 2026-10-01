import 'reflect-metadata';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  registerDecorator,
  ValidateIf,
  ValidateNested,
  type ValidationArguments,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  abbreviateLongMunicipality,
  isPostalAgolService,
  matchCountry,
  POSTAL_AGOL_NOTIFIER_TYPES,
  POSTAL_AGOL_SECOND_ATTEMPT_OPTIONS,
  SEND_PHYSICAL_COMMUNICATION_TYPES,
  type NotificationChannel,
  type SendPhysicalCommunicationType,
} from '@comunicapa/shared-types';
import type { ValidationIssue } from '../external-api.error.js';
import { validateBody } from '../validate-body.util.js';

export const APP_IO_LIMITS = { subject: [10, 120], body: [80, 10000] } as const;

/** Stesso stripping del wizard (isWizBodyEmpty / wizPlainTextLength in App.tsx): PagoPA misura il testo visibile. */
export function stripHtmlForLength(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
}

/** Vincolo su un valore PRESENTE che dipende da un campo fratello (stesso oggetto). */
function SiblingRule<T>(message: string, check: (value: unknown, self: T) => boolean): PropertyDecorator {
  return (object: object, propertyName: string | symbol) => {
    registerDecorator({
      name: `siblingRule_${String(propertyName)}`,
      target: object.constructor,
      propertyName: propertyName as string,
      options: { message },
      validator: {
        validate: (value: unknown, args: ValidationArguments) => check(value, args.object as T),
      },
    });
  };
}

function isItalian(country: string | undefined): boolean {
  return !country?.trim() || matchCountry(country.trim()) === 'Italia';
}

export class AddressDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  street!: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  zip?: string;

  // Uno dei 5 comuni italiani noti oltre 30 caratteri → forma abbreviata (stessa regola della correzione indirizzo).
  @Transform(({ value }) => (typeof value === 'string' ? abbreviateLongMunicipality(value) : value))
  @IsString()
  @MinLength(1)
  @MaxLength(30, { message: 'municipality non può superare 30 caratteri' })
  municipality!: string;

  @ValidateIf((o: AddressDto) => isItalian(o.country) || o.province !== undefined)
  @IsString({ message: 'province obbligatoria per indirizzi italiani' })
  @Matches(/^[A-Za-z]{2}$/, { message: 'province deve essere la sigla di 2 lettere' })
  province?: string;

  @IsOptional()
  @IsString()
  @SiblingRule<AddressDto>('country non riconosciuto', (v) => matchCountry(String(v)) !== null)
  country?: string;
}

export class RecipientDto {
  @IsIn(['PF', 'PG'])
  type!: 'PF' | 'PG';

  @IsString()
  @SiblingRule<RecipientDto>('taxId deve essere un codice fiscale di 16 caratteri (PF) o una partita IVA di 11 cifre (PG)', (v, self) =>
    typeof v === 'string' && (self.type === 'PG' ? /^\d{11}$/.test(v) : /^[A-Za-z0-9]{16}$/.test(v)),
  )
  taxId!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fullName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsEmail()
  pec?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;
}

export class ContentDto {
  @IsString()
  @MaxLength(10000)
  subject!: string;

  @IsOptional()
  @IsString()
  body?: string;
}

export class AttachmentRefDto {
  /** Sempre randomUUID() server-side: @IsUUID blocca path traversal prima di tokens.resolve(). */
  @IsUUID()
  token!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;
}

export class PaymentDto {
  @Matches(/^\d{18}$/, { message: 'noticeCode deve essere il codice avviso pagoPA di 18 cifre' })
  noticeCode!: string;

  @IsInt()
  @Min(1)
  amountCents!: number;

  @Matches(/^\d{11}$/, { message: 'creditorTaxId deve essere il codice fiscale ente di 11 cifre' })
  creditorTaxId!: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dueDate deve essere in formato YYYY-MM-DD' })
  dueDate?: string;
}

export class SenderDto {
  @IsOptional() @IsUUID() mailConfigId?: string;
  @IsOptional() @IsUUID() pecReserveMailConfigId?: string;
  @IsOptional() @IsUUID() ioServiceId?: string;
}

export class AppIoParallelDto {
  @IsOptional() @IsString() subject?: string;
  @IsOptional() @IsString() body?: string;
}

export class SendOptionsDto {
  @Matches(/^\d{6}[PN]$/, { message: 'taxonomyCode non valido (6 cifre + P/N)' })
  taxonomyCode!: string;

  @IsOptional()
  @IsIn([...SEND_PHYSICAL_COMMUNICATION_TYPES])
  physicalCommunicationType?: SendPhysicalCommunicationType;
}

export class PostalAgolDto {
  @IsOptional() @IsIn([...POSTAL_AGOL_NOTIFIER_TYPES]) notifierType?: string;
  @IsOptional() @IsIn([...POSTAL_AGOL_SECOND_ATTEMPT_OPTIONS]) secondAttempt?: string;
  @IsOptional() @IsString() @MaxLength(100) notifierName?: string;
  @IsOptional() @IsString() @MaxLength(50) chronologicalNumber?: string;
}

export class PostalOptionsDto {
  @IsOptional() @IsString() serviceType?: string;
  @IsOptional() @IsString() contractCode?: string;
  @IsOptional() @IsBoolean() returnReceipt?: boolean;
  @IsOptional() @IsBoolean() color?: boolean;
  @IsOptional() @IsBoolean() duplex?: boolean;
  @IsOptional() @IsString() coverPageId?: string;

  @IsOptional()
  @SiblingRule<PostalOptionsDto>('agol ammesso solo con un serviceType Agol', (_v, self) => !!self.serviceType && isPostalAgolService(self.serviceType))
  @ValidateNested()
  @Type(() => PostalAgolDto)
  agol?: PostalAgolDto;
}

export class CreateNotificationDto {
  @IsIn(['EMAIL', 'PEC', 'APP_IO', 'SEND', 'POSTAL'])
  channel!: NotificationChannel;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalReference?: string;

  @ValidateNested()
  @Type(() => RecipientDto)
  recipient!: RecipientDto;

  @ValidateNested()
  @Type(() => ContentDto)
  content!: ContentDto;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AttachmentRefDto)
  attachments?: AttachmentRefDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => PaymentDto)
  payment?: PaymentDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SenderDto)
  sender?: SenderDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AppIoParallelDto)
  appIoParallel?: AppIoParallelDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SendOptionsDto)
  send?: SendOptionsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PostalOptionsDto)
  postal?: PostalOptionsDto;
}

const PHYSICAL: readonly string[] = ['SEND', 'POSTAL'];

function appIoTextOk(subject: string, body: string): boolean {
  const plain = stripHtmlForLength(body);
  return (
    subject.length >= APP_IO_LIMITS.subject[0] && subject.length <= APP_IO_LIMITS.subject[1] &&
    plain.length >= APP_IO_LIMITS.body[0] && plain.length <= APP_IO_LIMITS.body[1]
  );
}

/**
 * Regole che dipendono dal canale, su un DTO di formato già valido. Riprendono
 * senza modifiche le regole v1 verificate contro il wizard admin (subject
 * sempre obbligatorio; body vietato per SEND/POSTAL; vincoli PagoPA App IO sul
 * testo visibile; App IO parallela solo per EMAIL/PEC/POSTAL, override
 * obbligatori per POSTAL).
 */
export function channelRuleIssues(dto: CreateNotificationDto): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });
  const ch = dto.channel;
  const physical = PHYSICAL.includes(ch);
  const r = dto.recipient;

  if (ch === 'EMAIL' && !r.email) add('recipient.email', 'email obbligatoria per il canale EMAIL');
  if (ch === 'PEC' && !r.pec) add('recipient.pec', 'pec obbligatoria per il canale PEC');
  if (physical && !r.fullName?.trim()) add('recipient.fullName', 'fullName obbligatorio per SEND e POSTAL');
  if (physical && !r.address) add('recipient.address', 'address obbligatorio per SEND e POSTAL');
  if (!physical && r.address) add('recipient.address', 'address ammesso solo per SEND e POSTAL');

  const subject = dto.content.subject;
  if (!subject.trim()) add('content.subject', 'subject obbligatorio (non vuoto)');
  else if (ch === 'APP_IO' && (subject.length < APP_IO_LIMITS.subject[0] || subject.length > APP_IO_LIMITS.subject[1])) {
    add('content.subject', `subject deve avere tra ${APP_IO_LIMITS.subject[0]} e ${APP_IO_LIMITS.subject[1]} caratteri per APP_IO`);
  }

  const body = dto.content.body;
  if (physical) {
    if (body !== undefined) add('content.body', `body non ammesso per ${ch}: il contenuto notificato sono gli allegati`);
  } else if (body === undefined || !stripHtmlForLength(body)) {
    add('content.body', 'body obbligatorio (testo visibile non vuoto)');
  } else if (ch === 'APP_IO') {
    const len = stripHtmlForLength(body).length;
    if (len < APP_IO_LIMITS.body[0] || len > APP_IO_LIMITS.body[1]) {
      add('content.body', `body deve avere tra ${APP_IO_LIMITS.body[0]} e ${APP_IO_LIMITS.body[1]} caratteri visibili per APP_IO`);
    }
  }

  if (physical && !dto.attachments?.length) add('attachments', 'attachments obbligatorio (almeno 1) per SEND e POSTAL');
  if (dto.payment && ch !== 'SEND' && ch !== 'APP_IO') add('payment', 'payment ammesso solo per SEND e APP_IO');
  if (ch === 'SEND' && !dto.send) add('send', 'send obbligatorio per il canale SEND');
  if (ch !== 'SEND' && dto.send) add('send', 'send ammesso solo per il canale SEND');
  if (ch !== 'POSTAL' && dto.postal) add('postal', 'postal ammesso solo per il canale POSTAL');

  const p = dto.appIoParallel;
  if (p) {
    if (!['EMAIL', 'PEC', 'POSTAL'].includes(ch)) {
      add('appIoParallel', 'appIoParallel ammesso solo per EMAIL, PEC e POSTAL');
    } else if (ch === 'POSTAL' && (!p.subject || !p.body)) {
      add('appIoParallel', 'per POSTAL appIoParallel.subject e appIoParallel.body sono obbligatori');
    } else if (!appIoTextOk(p.subject ?? subject, p.body ?? body ?? '')) {
      add(
        'appIoParallel',
        `testo App IO effettivo (override o content): oggetto ${APP_IO_LIMITS.subject[0]}-${APP_IO_LIMITS.subject[1]}, testo ${APP_IO_LIMITS.body[0]}-${APP_IO_LIMITS.body[1]} caratteri visibili`,
      );
    }
  }
  return issues;
}

export async function validateCreateNotification(body: unknown): Promise<{ value: CreateNotificationDto; issues: ValidationIssue[] }> {
  const { value, issues } = await validateBody(CreateNotificationDto, body);
  if (issues.length) return { value, issues };
  return { value, issues: channelRuleIssues(value) };
}
