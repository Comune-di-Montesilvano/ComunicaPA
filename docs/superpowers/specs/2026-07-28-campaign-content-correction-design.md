# Correzione contenuto campagna + resend sicuro (errata corrige)

Data: 2026-07-28

## Contesto

Bug reale (fix v1.4.8, vedi commit `64d2aab`): `handleWizLaunch()` nel wizard
non scriveva `channelConfig.body` per campagne POSTAL — solo `subject`. Una
campagna reale (TARI POSTAL AR, INAD attivo, App IO parallela) è stata
lanciata con questo bug attivo:

- 23 destinatari dirottati da INAD su PEC: canale effettivo (`attempt.channelType`)
  già PEC, ma hanno ricevuto solo il testo di default (`channelConfig.body`
  assente → fallback hardcoded in `pec.strategy.ts`).
- 115 destinatari con co-consegna App IO parallela alla lettera POSTAL: hanno
  ricevuto un messaggio App IO con solo il testo automatico di cortesia
  (`buildParallelChannelNotice`), body vuoto.

Il fix v1.4.8 corregge il wizard per i lanci futuri, ma non è retroattivo:
il `channelConfig` di questa campagna resta salvato senza `body`. Serve un
modo per:

1. Correggere `subject`/`body` di una campagna già lanciata, conservando
   uno storico di cosa c'era prima (comunicazioni PA, serve poter dimostrare
   "cosa è stato effettivamente mandato e quando è stato corretto").
2. Rimandare il contenuto corretto SOLO ai destinatari per cui è sicuro
   farlo — mai un secondo invio POSTAL/SEND (spedizione fisica/legale,
   irreversibile, costosa, rischio di duplicati/confusione per il
   cittadino).

## Principio di sicurezza (non negoziabile)

**Nessuna azione di questa feature accoda mai un job sul canale POSTAL o
SEND.** Hardcoded, non configurabile. Se un domani serve rifare anche
quei canali, è una decisione manuale separata, fuori da questo strumento.

## Componenti

### 1. Storico contenuto — `PATCH admin/campaigns/:id/content`

Body: `{ subject?: string; body?: string }`.

Merge-patch, mai replace: solo `channelConfig.subject`/`channelConfig.body`
vengono toccati, il resto di `channelConfig` resta intatto (a differenza
del `PATCH` generico esistente su `campaigns.service.ts`, che fa replace
completo — vedi CLAUDE.md, motivo per cui questo endpoint è dedicato e non
riusa quello generico).

Prima di sovrascrivere, la versione precedente viene accodata in
`channelConfig.contentHistory`:

```ts
interface ContentHistoryEntry {
  subject: string | null;
  body: string | null;
  changedBy: string;
  changedAt: string; // ISO
}
```

Storico a livello di TEMPLATE (con `%%placeholder%%` non risolti), non del
testo effettivamente ricevuto da ciascun destinatario — coerente con come
funziona oggi il resto del codice (nessuna strategy di invio salva il testo
risolto per persona, solo `channelConfig` a livello di campagna).

Vincoli:
- Richiede almeno uno tra `subject`/`body` nel body della richiesta,
  altrimenti `BadRequestException` (nessuna voce di history spuria per una
  chiamata no-op).
- Consentito solo se `campaign.status` è terminale (`COMPLETED`/`CANCELLED`/
  `FAILED` — mai su una campagna ancora `QUEUED`/`PROCESSING`, per non
  correggere il template mentre job in corso lo stanno ancora leggendo).

UI: nuova sezione "Storico contenuto" nel dettaglio campagna (collassabile,
sotto il blocco "Dettaglio Consegna Multicanale" già esistente) che elenca
le voci di `contentHistory` con data/operatore/anteprima subject+body.

### 2. `AppIoDeliveryService` — estratto da `NotificationProcessor`

Oggi la costruzione/invio del messaggio App IO (~130 righe: risoluzione
template subject/markdown, allegati, payment_data, chiamata PagoPA) vive
come metodo privato `sendAppIoMessage()` dentro `NotificationProcessor`
(`queue/notification.processor.ts`), irraggiungibile da fuori quel
processor.

Estratto in `apps/backend/src/channels/app-io/app-io-delivery.service.ts`,
stesse dipendenze già iniettate nel processor (`AppSettingsService`,
`ConfigService`), stessa firma pubblica:

```ts
class AppIoDeliveryService {
  checkProfile(baseUrl: string, apiKey: string, fiscalCode: string, onLog?: ChannelLogFn): Promise<boolean>;
  sendMessage(
    campaign: Campaign,
    recipient: Recipient,
    appIoConfig: { apiKey: string; baseUrl: string; subjectOverride?: string; bodyOverride?: string },
    onLog?: ChannelLogFn,
    parallelPrimaryChannel?: NotificationChannel,
  ): Promise<{ success: boolean; messageId?: string; error?: string }>;
}
```

`NotificationProcessor` diventa un consumatore di questo service (chiama
`this.appIoDelivery.sendMessage(...)` invece del metodo privato) — stesso
comportamento per la co-consegna inline al primo tentativo, nessuna
modifica funzionale lì. Firma costruttore di `NotificationProcessor`
cambiata (nuovo parametro) — audit di tutti gli spec che lo istanziano
direttamente (vedi CLAUDE.md, "Nuova dependency in un costruttore").

### 3. `CampaignContentCorrectionService` — classificazione e resend per destinatario

`apps/backend/src/campaigns/campaign-content-correction.service.ts`,
metodo `resendSafe(campaignId: string, recipientId: string): Promise<'resent' | 'skipped'>`:

1. Carica l'ultimo `NotificationAttempt` del destinatario.
2. Se `attempt.channelType` è `PEC`/`EMAIL`/`APP_IO` (canale già "sicuro" —
   es. dirottato INAD, che ha sempre come canale effettivo uno di questi
   tre, mai POSTAL/SEND): stesso pattern già usato da
   `updateRecipientAddressAndRetry()` in `campaigns.service.ts` — forza
   `RecipientStatus.FAILED` se non già tale, poi chiama il
   `retryRecipient()` esistente (rimanda l'intero canale, invariato,
   nessuna modifica a quel metodo). Ritorna `'resent'`.
3. Se `attempt.channelType` è `POSTAL`/`SEND`: controlla
   `attempt.responsePayload?.appIo?.success`.
   - Se assente/falso (mai stata co-consegna App IO riuscita per questo
     destinatario): nessun canale sicuro da rimandare, ritorna `'skipped'`.
   - Se presente: richiama `AppIoDeliveryService.checkProfile()` +
     `sendMessage()` direttamente (stessa configurazione risolta da
     `resolveSecondaryAppIoConfig(campaign.channelConfig)` +
     `ioServices.resolveApiKey()`, stesso codice già usato dal processor).
     Aggiorna `attempt.responsePayload` con **merge**, mai replace:
     `{ ...attempt.responsePayload, appIo: nuovoEsito }` — non tocca
     `attempt.status`/`recipient.status` (restano `SUCCESS`/`SENT`, il
     canale primario non è cambiato). Ritorna `'resent'` se
     `nuovoEsito.success`, altrimenti `'skipped'` (profilo App IO non più
     disponibile/disattivato dal cittadino — non un errore bloccante).

Metodo bulk `resendSafeBulk(campaignId: string, recipientIds: string[]): Promise<Array<{ recipientId: string; result: 'resent' | 'skipped' | 'error'; message?: string }>>` —
stesso cap `MAX_BULK_RETRY_SIZE` (500, riusa la costante esistente in
`campaigns.service.ts`) validato sia server-side (`BadRequestException`
sopra soglia) sia client-side prima di inviare la richiesta.

### 4. Endpoint `POST admin/campaigns/:id/resend-content`

Body: `{ recipientIds: string[] }`. Ritorna l'array di esiti di
`resendSafeBulk`. `@Roles('admin')` — azione che tocca dati di invio reali,
non 'user'.

### 5. Selezione destinatari in UI

Estende la lista "Destinatari Caricati" (già filtrabile per stato/consegna
da `4bd87fb`) con un filtro aggiuntivo per le categorie del widget
"Dettaglio Consegna Multicanale" esistente (`getChannelBreakdown`):
`primaryOnly` / `both` / `appIoOnly` / `appIoDespitePrimaryFail` /
`neither` / `inadDiverted`. Nuovo endpoint
`GET admin/campaigns/:id/recipients-by-channel-outcome?outcome=<key>`
(stessa classificazione già implementata in `getChannelBreakdown`, ma
ritorna la lista di `recipientId` invece del solo conteggio — la logica di
classificazione non si duplica, si estrae in una funzione condivisa che
`getChannelBreakdown` e questo nuovo endpoint richiamano entrambi).

UI: checkbox multi-selezione sulla lista filtrata + bottone "Rimanda con
contenuto corretto" (`role==='admin'` solo), con `confirm()` che mostra il
numero di destinatari coinvolti prima di procedere (stesso pattern già
usato per delete/cancel campagna).

## Error handling

- `PATCH content`: campagna non terminale → `BadRequestException`. Nessun
  campo `subject`/`body` nel body → `BadRequestException`.
- `resend-content`: `recipientIds` oltre `MAX_BULK_RETRY_SIZE` (500) →
  `BadRequestException`, nessun invio parziale. Un `recipientId` non
  appartenente alla campagna → esito `'error'` per quell'elemento, il
  batch continua sugli altri (stesso pattern `retryRecipientsBulk`).
- `resendSafe`: nessuna eccezione propagata verso il chiamante bulk — ogni
  fallimento (rete verso PagoPA, profilo App IO disattivato, retry
  fallito) diventa un esito `'skipped'`/`'error'` in quella riga
  dell'array di risposta, mai un throw che abortisce l'intero batch.
- Merge di `responsePayload.appIo`: sempre `{ ...existing, appIo: nuovo }`,
  mai un update che sovrascrive l'intero campo (perderebbe `envelope`/dati
  già scritti dal canale primario).

## Testing

- Unit `campaign-content-correction.service.spec.ts`: i 3 casi di
  classificazione (`PEC`/`EMAIL`/`APP_IO` → retry esistente; `POSTAL`/`SEND`
  con appIo pregresso → resend solo appIo; `POSTAL`/`SEND` senza appIo
  pregresso → skipped), merge di `responsePayload` non perde `envelope`,
  cap bulk a 500.
- Unit `app-io-delivery.service.spec.ts`: stesso comportamento oggi già
  coperto in `notification.processor.spec.ts` per la parte App IO,
  spostato sul nuovo service — stesso contratto, nessuna regressione.
- Unit `notification.processor.spec.ts`: aggiornato per il nuovo parametro
  costruttore (`AppIoDeliveryService` mockato).
- Unit sull'endpoint `PATCH content`: history popolata correttamente,
  merge non tocca altre chiavi di `channelConfig`, blocco su campagna non
  terminale.
- E2E manuale (Docker), sulla campagna reale in oggetto dopo deploy:
  1. `PATCH content` con testo corretto, verificare `contentHistory`
     popolato con la versione precedente (vuota/default).
  2. Filtro UI su `inadDiverted` (23) + `both` (115), selezione multipla,
     "Rimanda con contenuto corretto".
  3. Verificare via log/coda che nessun job venga accodato su
     `POSTAL`/`SEND` per questi destinatari.
  4. Verificare che i 23 dirottati ricevano una nuova PEC col contenuto
     corretto, i 115 un nuovo messaggio App IO col contenuto corretto,
     lettera cartacea invariata (nessun secondo invio).

## Fuori scope (YAGNI)

- Storicizzazione del testo RISOLTO per singolo destinatario (snapshot con
  placeholder già sostituiti) — deciso: storico solo a livello template
  campagna, non per-persona (richiederebbe toccare tutte le strategy di
  invio, sproporzionato rispetto al bisogno attuale).
- Resend automatico/schedulato — sempre un'azione operatore esplicita,
  mai un demone che rimanda in automatico.
- Estensione della stessa logica a POSTAL/SEND — deliberatamente escluso,
  vedi "Principio di sicurezza" sopra.
