import 'reflect-metadata';
import {
  ArrayMinSize,
  Equals,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  registerDecorator,
  ValidateIf,
  ValidateNested,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { NotificationChannel } from '@comunicapa/shared-types';

const CF_PATTERN = /^[A-Za-z0-9]{16}$/;

const APP_IO_SUBJECT_MIN = 10;
const APP_IO_SUBJECT_MAX = 120;
const APP_IO_BODY_MIN = 80;
const APP_IO_BODY_MAX = 10000;

// Canali per cui subject/body sono contenuto reale (vs POSTAL, dove il
// contenuto notificato è negli allegati — vedi CLAUDE.md "POSTAL:
// channelConfig.body/subject NON sono il contenuto reale inviato").
const TEXT_REQUIRED_CHANNELS = ['EMAIL', 'PEC', 'APP_IO'];

/**
 * Validatore custom invece di due @ValidateIf stackati sulla stessa
 * property: class-validator tratta OGNI @ValidateIf su una property come un
 * gate che va in AND con gli altri (vedi ValidationExecutor.performValidations
 * → conditionalValidations su TUTTI i metadata condizionali della property),
 * non un OR tra rami — due @ValidateIf con condizioni sul canale mutuamente
 * esclusive (es. una per APP_IO, una per EMAIL/PEC) si annullerebbero a
 * vicenda per QUALSIASI canale, saltando la validazione sempre. Un solo
 * validatore custom che branch-a internamente su channelType evita il
 * problema.
 */
function IsValidChannelText(kind: 'subject' | 'body', validationOptions?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol) {
    registerDecorator({
      name: `isValidChannel${kind === 'subject' ? 'Subject' : 'Body'}`,
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const o = args.object as CreateExternalNotificationDto;
          // POSTAL: il body reale sono gli allegati, subject/body non
          // validati/richiesti qui, qualunque valore (anche assente) va bene.
          if (o.channelType === 'POSTAL') return true;

          const required = TEXT_REQUIRED_CHANNELS.includes(o.channelType);
          if (value === undefined) return !required;
          if (typeof value !== 'string' || value.length === 0) return false;

          if (o.channelType === 'APP_IO') {
            const [min, max] = kind === 'subject' ? [APP_IO_SUBJECT_MIN, APP_IO_SUBJECT_MAX] : [APP_IO_BODY_MIN, APP_IO_BODY_MAX];
            return value.length >= min && value.length <= max;
          }
          return true;
        },
        defaultMessage(args: ValidationArguments): string {
          const o = args.object as CreateExternalNotificationDto;
          if (o.channelType === 'APP_IO') {
            return kind === 'subject'
              ? `subject deve avere lunghezza tra ${APP_IO_SUBJECT_MIN} e ${APP_IO_SUBJECT_MAX} caratteri`
              : `body deve avere lunghezza tra ${APP_IO_BODY_MIN} e ${APP_IO_BODY_MAX} caratteri`;
          }
          return `${kind} obbligatorio (stringa non vuota) per canale ${o.channelType}`;
        },
      },
    });
  };
}

class ExternalAttachmentRefDto {
  /**
   * Sempre generato server-side come randomUUID() da
   * ExternalAttachmentTokensService.completeUpload — un chiamante legittimo
   * non ha mai motivo di mandare altro. @IsUUID() blocca qui qualunque
   * payload di path-traversal (es. "../<altro-client>/<token>") PRIMA che
   * arrivi a tokens.resolve()/join(root, clientId, token): senza questo
   * vincolo, resolve() normalizzerebbe il path fuori dalla cartella del
   * client chiamante, restituendo l'allegato di un client diverso.
   */
  @IsString()
  @IsUUID()
  token!: string;

  @IsString()
  @IsOptional()
  label?: string;
}

/**
 * Stesso principio di TestSendDto (test-send.dto.ts): `extraData` porta
 * qualunque colonna aggiuntiva il chiamante voglia passare (es. indirizzo
 * postale completo per POSTAL) — il backend non deduce mapping, il
 * chiamante esterno mette le chiavi che il canale scelto si aspetta.
 *
 * Validazione nuova, non esiste altrove nel backend fuori dal frontend
 * wizard (vedi design doc): questo DTO è l'UNICO gate per un payload che
 * arriva senza mai passare dalle validazioni client-side di App.tsx.
 */
class SecondaryAppIoDto {
  @IsString()
  @IsOptional()
  subjectOverride?: string;

  @IsString()
  @IsOptional()
  bodyOverride?: string;
}

export class CreateExternalNotificationDto {
  @IsIn(['PEC', 'EMAIL', 'APP_IO', 'SEND', 'POSTAL'])
  channelType!: NotificationChannel;

  /**
   * Co-consegna App IO in parallelo (mai esclusiva — vedi design doc,
   * sezione "Eccezione — App IO parallela": l'esclusiva presuppone un check
   * di dirottamento che il client ha già fatto a monte via domicilio/cerca).
   */
  @ValidateNested()
  @Type(() => SecondaryAppIoDto)
  @IsOptional()
  secondaryAppIo?: SecondaryAppIoDto;

  @IsString()
  @Matches(CF_PATTERN, { message: 'codiceFiscale deve essere alfanumerico di 16 caratteri' })
  codiceFiscale!: string;

  @ValidateIf((o) => o.channelType === 'EMAIL' && !o.pec)
  @IsString({ message: 'email obbligatoria per canale EMAIL (o valorizzare pec)' })
  email?: string;

  @ValidateIf((o) => o.channelType === 'PEC' && !o.email)
  @IsString({ message: 'pec obbligatoria per canale PEC (o valorizzare email)' })
  pec?: string;

  @IsObject()
  extraData!: Record<string, string>;

  /**
   * NIENTE `@IsOptional()` qui, deliberatamente: la versione originale del
   * brief lo aveva insieme a `@ValidateIf`, ma `@IsOptional()` salta
   * l'intera catena di validatori della property quando il valore è
   * `undefined` — PRIMA che `@ValidateIf` possa decidere se il campo è
   * davvero opzionale per il canale corrente. Risultato verificato
   * empiricamente: un payload SEND/POSTAL che OMETTE del tutto
   * `attachments` (non un array vuoto, proprio il campo assente) non
   * produceva alcun errore, mentre `attachments: []` sì — incoerente con
   * "obbligatorio (almeno 1) per SEND e POSTAL", e il caso più probabile
   * per un chiamante esterno reale (omettere il campo, non inviarlo vuoto).
   * `@ValidateIf` da solo basta a rendere il campo opzionale per gli altri
   * canali: se la condizione è falsa, class-validator salta l'INTERA
   * catena di validatori della property, non serve `@IsOptional()`.
   */
  @ValidateIf((o) => o.channelType === 'SEND' || o.channelType === 'POSTAL')
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExternalAttachmentRefDto)
  @ArrayMinSize(1, { message: 'attachments obbligatorio (almeno 1) per SEND e POSTAL' })
  attachments?: ExternalAttachmentRefDto[];

  @ValidateIf((o) => o.channelType === 'SEND')
  @Equals(true, { message: 'protocolla deve essere true per canale SEND' })
  protocolla?: boolean;

  @IsValidChannelText('subject')
  subject?: string;

  @IsValidChannelText('body')
  body?: string;
}
