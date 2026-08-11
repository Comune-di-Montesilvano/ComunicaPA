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
 * Il campo "Corpo del Messaggio" del wizard (EMAIL/PEC/APP_IO) è HTML
 * (TemplateEditor), non testo semplice — PagoPA valuta il vincolo di
 * lunghezza su `content.markdown` (testo effettivamente visibile), non sui
 * caratteri di markup. Stessa regex usata dal wizard per lo stesso scopo
 * (`apps/frontend-admin/src/App.tsx` `wizPlainTextLength()`, riga 984-986,
 * e `isWizBodyEmpty()`, riga 948-951) — un body con 79 caratteri visibili
 * ma 120 di markup deve restare sotto il minimo App IO, non sopra.
 */
function stripHtmlForLength(value: string): string {
  return value.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
}

/**
 * Regole verificate contro il wizard reale, `apps/frontend-admin/src/App.tsx`.
 * `createAndLaunch` imposta sempre `channelConfig.wizSingleMode = true`
 * (external-api.service.ts:41), quindi l'equivalente wizard di ogni
 * chiamata esterna è SEMPRE "invio singolo".
 *
 * ATTENZIONE gate corretto da usare: in modalità singola, per SEND/POSTAL
 * lo step "Template" (step4, dove vive il gate "Riepilogo" righe
 * ~10455-10467/10672-10684) viene SALTATO del tutto
 * (`wizSingleNeedsTemplateStep = wizChannel==='EMAIL'||'PEC'||'APP_IO'`,
 * riga 1855; step-bar singola mostra solo `[1,4,6]` per i canali con
 * template, `[1,6]` per SEND/POSTAL) — quel gate non è mai raggiunto per
 * questi due canali quando `wizSingleMode` è vero. Il gate REALMENTE
 * eseguito per SEND/POSTAL in modalità singola è quello dei bottoni
 * "Avvia Test"/"Conferma ed Avvia Campagna" allo step6 (righe
 * 11021/11029, duplicato 11172/11180):
 * `disabled = wizSending || (wizSingleMode && !wizSingleNeedsTemplateStep && !wizSubject.trim())`
 * — cioè, per SEND e POSTAL in modalità singola, `subject` è SEMPRE
 * obbligatorio, incondizionatamente, senza eccezioni legate a
 * `secondaryAppIo`/co-consegna App IO (quella condizione appartiene solo
 * al gate step4, mai raggiunto qui).
 *
 * subject ("Oggetto della Comunicazione"): obbligatorio per TUTTI i canali
 * — EMAIL/PEC/APP_IO tramite il gate step4 (mai saltato per loro, riga
 * 1855), SEND/POSTAL tramite il gate step6 sopra. Nessuna eccezione.
 *
 * body ("Corpo del Messaggio"): il campo è strutturalmente ASSENTE dal DOM
 * per SEND e POSTAL in modalità singola: per SEND lo step template non
 * esiste (riga 1855); per POSTAL, anche nei rari casi in cui lo step
 * esisterebbe, riga 10514 lo renderizza solo se `!wizSingleMode` (mai vero
 * qui). Non solo facoltativo: non c'è alcun modo per il chiamante reale
 * del wizard di valorizzarlo per questi due canali. Il DTO quindi RIFIUTA
 * un body valorizzato per SEND/POSTAL, non lo ignora silenziosamente.
 * Obbligatorio per EMAIL/PEC/APP_IO. Per APP_IO, il vincolo di lunghezza
 * PagoPA [80,10000] va misurato su testo HTML-stripped (vedi
 * `stripHtmlForLength`), non sui caratteri grezzi.
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

          // EMAIL, PEC, APP_IO, SEND, POSTAL: subject/body (quando
          // applicabile) sempre obbligatorio, nessuna eccezione per canale.
          if (value === undefined) return false;
          if (typeof value !== 'string') return false;
          // subject è testo semplice: trim() basta (parità con
          // `!wizSubject.trim()`, App.tsx). body è HTML (TemplateEditor):
          // serve lo stesso stripping usato per il vincolo di lunghezza
          // (parità con `isWizBodyEmpty()`, App.tsx) — un `<p></p>` vuoto
          // (shell Tiptap) ha length>0 ma nessun testo visibile.
          const isEmpty = kind === 'subject' ? value.trim().length === 0 : stripHtmlForLength(value).length === 0;
          if (isEmpty) return false;

          if (o.channelType === 'APP_IO') {
            if (kind === 'subject') {
              return value.length >= APP_IO_SUBJECT_MIN && value.length <= APP_IO_SUBJECT_MAX;
            }
            const plain = stripHtmlForLength(value);
            return plain.length >= APP_IO_BODY_MIN && plain.length <= APP_IO_BODY_MAX;
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
              : `body deve avere lunghezza tra ${APP_IO_BODY_MIN} e ${APP_IO_BODY_MAX} caratteri di testo visibile (tag HTML esclusi dal conteggio)`;
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
 * - Per POSTAL, `subjectOverride`/`bodyOverride` sono SEMPRE obbligatori
 *   quando `secondaryAppIo` è presente. Questa regola NON è giustificata
 *   da parità wizard stretta (l'`useEffect` di App.tsx riga 2279 che forza
 *   `wizAppIoDifferentiate=true` per POSTAL in singolo esiste, ma nessun
 *   punto raggiungibile del gate step6 single-mode — vedi
 *   `IsValidChannelText` sopra — lo verifica più a valle): è una regola
 *   giustificata a runtime, non da UI. POSTAL non ha mai un `body`
 *   primario valorizzabile (rifiutato per quel canale, vedi sopra): senza
 *   override, `app-io-delivery.service.ts` (righe 72/76) ricadrebbe su
 *   `bodyOverride || channelConfig.body || ''` → stringa vuota → PagoPA
 *   risponderebbe 400 al momento dell'invio reale. Bloccarlo qui, in
 *   validazione, evita di accettare un payload che fallirebbe comunque a
 *   valle in modo silenzioso/asincrono.
 * - Per EMAIL/PEC, la differenziazione resta scelta del chiamante: se un
 *   override manca, il testo App IO effettivamente inviato ricade sul
 *   subject/body principale (stesso fallback di
 *   `app-io-delivery.service.ts` righe 72/76: `override || channelConfig
 *   subject/body`) — quel testo effettivo deve comunque rispettare i
 *   vincoli PagoPA su content.subject/content.markdown (App.tsx
 *   `wizAppIoSubjectLenInvalid`/`wizAppIoBodyLenInvalid`, righe 2106-2118,
 *   `body` misurato HTML-stripped come in `IsValidChannelText`), non solo
 *   quando c'è un override esplicito.
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
          const effBodyRaw = v.bodyOverride ?? o.body ?? '';
          const effBody = stripHtmlForLength(effBodyRaw);
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
