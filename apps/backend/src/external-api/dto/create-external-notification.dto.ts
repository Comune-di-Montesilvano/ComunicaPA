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

/**
 * Regole verificate contro il wizard reale (`apps/frontend-admin/src/App.tsx`,
 * gate del bottone "Riepilogo" step4→5, righe ~10455-10467/10672-10684) —
 * `createAndLaunch` imposta sempre `channelConfig.wizSingleMode = true`
 * (external-api.service.ts), quindi l'equivalente wizard di ogni chiamata
 * esterna è SEMPRE "invio singolo": il ramo `!wizSingleMode` di quelle
 * condizioni è sempre falso, e questo file riflette la formula già
 * semplificata per quel caso, non la formula generale bulk-CSV.
 *
 * subject ("Oggetto della Comunicazione"): il campo NON è mai nascosto in
 * UI (input sempre renderizzato indipendentemente dal canale, riga ~10501),
 * quindi è sempre di tipo stringa se presente. È obbligatorio (`!wizSubject`
 * nel gate) per OGNI canale tranne POSTAL puro senza co-consegna App IO
 * (unico bypass completo del gate, riga 10457/10674) — quindi obbligatorio
 * anche per SEND (bug corretto qui: la versione precedente di questo file
 * lo dava per opzionale) e per POSTAL quando è presente `secondaryAppIo`
 * (il gate richiede `!wizSubject` incondizionatamente in quel ramo, anche
 * se per POSTAL la differenziazione App IO è sempre forzata — riga 2279 —
 * quindi quel valore di `subject` non finisce mai come contenuto reale
 * dell'App IO co-consegnata: è comunque un campo obbligatorio nel wizard,
 * non un'inferenza nostra).
 *
 * body ("Corpo del Messaggio"): il campo è strutturalmente ASSENTE dal DOM
 * per SEND (sempre) e per POSTAL (sempre, in modalità wizSingleMode=true —
 * riga 10514: la condizione che lo renderizzerebbe per POSTAL richiede
 * `!wizSingleMode`, mai vero qui) — non solo facoltativo, proprio non
 * inviabile dal chiamante reale del wizard. Per questi due canali il DTO
 * quindi RIFIUTA un body valorizzato, non lo ignora silenziosamente (bonus
 * "reject if channel doesn't use it" richiesto — qui l'evidenza UI è
 * inequivocabile, a differenza del caso subject/POSTAL sopra). Obbligatorio
 * per EMAIL/PEC/APP_IO (sempre renderizzato e richiesto per quei canali).
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

          if (kind === 'body' && (o.channelType === 'SEND' || o.channelType === 'POSTAL')) {
            // Campo mai renderizzato in UI per questi due canali (vedi
            // commento sopra) — un valore fornito è un dato che il canale
            // non gestisce affatto, non un "opzionale ignorato".
            return value === undefined;
          }

          if (kind === 'subject' && o.channelType === 'POSTAL') {
            // Obbligatorio solo se presente co-consegna App IO
            // (`secondaryAppIo`), facoltativo altrimenti — riflette
            // esattamente il bypass del gate wizard (righe 10457/10674).
            const required = !!o.secondaryAppIo;
            if (value === undefined) return !required;
            return typeof value === 'string' && value.length > 0;
          }

          const required = true; // EMAIL, PEC, APP_IO, SEND: sempre obbligatorio se si arriva qui
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
          if (kind === 'body' && (o.channelType === 'SEND' || o.channelType === 'POSTAL')) {
            return `body non è gestito dal canale ${o.channelType} (il wizard non espone mai questo campo per questo canale) — non inviarlo`;
          }
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

/**
 * Regole per `secondaryAppIo` verificate contro il wizard reale:
 *
 * - Selettore App IO secondaria renderizzato SOLO per canale primario
 *   EMAIL/PEC/POSTAL (App.tsx righe 369, 10584, 11073 — sempre gated
 *   `wizChannel === 'EMAIL' || wizChannel === 'PEC' || wizChannel ===
 *   'POSTAL'`): per APP_IO è ridondante (canale già App IO), per SEND non
 *   esiste proprio (pipeline propria, escluso da `isMailChannel` — vedi
 *   matrice comportamenti campagne). Quindi `secondaryAppIo` va RIFIUTATO
 *   per questi due canali, non ignorato.
 * - Per POSTAL, la differenziazione App IO è sempre forzata (App.tsx
 *   useEffect riga 2279, perché POSTAL non ha un body "riusabile" — è
 *   HTML da stampa, non testo per notifica push): `subjectOverride` e
 *   `bodyOverride` sono quindi SEMPRE obbligatori quando `secondaryAppIo`
 *   è presente per POSTAL, mai opzionali con fallback.
 * - Per EMAIL/PEC, la differenziazione resta scelta del chiamante: se un
 *   override manca, il testo App IO effettivamente inviato ricade sul
 *   subject/body principale (stesso fallback di
 *   `app-io-delivery.service.ts` righe 72/76: `override || channelConfig
 *   subject/body`) — quel testo effettivo deve comunque rispettare i
 *   vincoli PagoPA su content.subject/content.markdown (App.tsx
 *   `wizAppIoSubjectLenInvalid`/`wizAppIoBodyLenInvalid`, righe 2106-2118),
 *   non solo quando c'è un override esplicito.
 */
function IsValidSecondaryAppIo(validationOptions?: ValidationOptions): PropertyDecorator {
  return function (object: object, propertyName: string | symbol) {
    registerDecorator({
      name: 'isValidSecondaryAppIo',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (value === undefined) return true;
          const o = args.object as CreateExternalNotificationDto;

          if (o.channelType === 'APP_IO' || o.channelType === 'SEND') return false;

          const v = value as SecondaryAppIoDto;

          if (o.channelType === 'POSTAL' && (!v.subjectOverride || !v.bodyOverride)) return false;

          const effSubject = v.subjectOverride ?? o.subject ?? '';
          const effBody = v.bodyOverride ?? o.body ?? '';
          if (effSubject.length < APP_IO_SUBJECT_MIN || effSubject.length > APP_IO_SUBJECT_MAX) return false;
          if (effBody.length < APP_IO_BODY_MIN || effBody.length > APP_IO_BODY_MAX) return false;

          return true;
        },
        defaultMessage(args: ValidationArguments): string {
          const o = args.object as CreateExternalNotificationDto;
          if (o.channelType === 'APP_IO' || o.channelType === 'SEND') {
            return `secondaryAppIo non è disponibile per canale primario ${o.channelType} (co-consegna App IO applicabile solo a EMAIL/PEC/POSTAL)`;
          }
          if (o.channelType === 'POSTAL') {
            return 'secondaryAppIo.subjectOverride e bodyOverride sono obbligatori per canale POSTAL (nessun testo riutilizzabile dal corpo della lettera)';
          }
          return `secondaryAppIo: oggetto/testo App IO effettivo (override o fallback su subject/body) deve rispettare i vincoli PagoPA — oggetto ${APP_IO_SUBJECT_MIN}-${APP_IO_SUBJECT_MAX} caratteri, testo ${APP_IO_BODY_MIN}-${APP_IO_BODY_MAX} caratteri`;
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
  @IsValidSecondaryAppIo()
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
