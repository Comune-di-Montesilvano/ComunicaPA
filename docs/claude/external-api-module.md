# External API module

## External API (`external-api/`) — due gotcha reali, non presi dalla suite unit

**Modulo consumato solo internamente prima → serve `exports` esplicito
quando arriva un nuovo consumer esterno al modulo.** `DomicilioModule`
dichiarava `providers: [DomicilioService]` ma nessun `exports` (mai servito
finora: `DomicilioController` lo usava dentro lo stesso modulo).
`ExternalApiModule`, importando `DomicilioModule` per riusare
`DomicilioService` nel nuovo `ExternalDomicilioController`, andava in
crash-loop al boot reale (`docker compose up`) — DI di Nest non risolve un
provider non esportato attraverso un `imports`. Nessuno unit test lo
intercetta: i service spec istanziano `new DomicilioService(...)`
direttamente, bypassando interamente il grafo dei moduli Nest. Fix: aggiungere
`exports: [DomicilioService]` a `DomicilioModule`. Ogni volta che un modulo
esistente guadagna un nuovo consumer esterno (anche se già usato da tempo
internamente), verificare che i provider richiesti siano in `exports` — non
darlo per scontato solo perché funzionava prima.

**`@Post()` di NestJS risponde 201 di default, non 200 — serve
`@HttpCode(HttpStatus.OK)` esplicito su ogni handler POST di `external/v2/*`.**
Il contratto "always 200" per gli endpoint `external/v2/*` (stesso principio
della sezione "Reverse proxy esterno in produzione" sopra) è normalizzato
solo per il path di errore da `ExternalApiExceptionFilter` — un handler che
risponde con successo mantiene lo status HTTP di default di Nest, 201 per
`@Post()`. `ExternalNotificationsController.create()` ed
`ExternalAttachmentsController` (init/chunk/complete) sono partiti senza
`@HttpCode(HttpStatus.OK)` per 11 task, mai scoperto perché ogni unit test
chiamava i metodi controller direttamente e asseriva solo sul corpo della
risposta, mai sullo status HTTP che Nest avrebbe realmente prodotto — emerso
solo con un E2E che boota l'app e fa richieste HTTP vere (task 12). Ogni
nuovo handler `@Post()` sotto `external/v2/*` va annotato esplicitamente,
non assumere che il filtro di eccezioni copra anche il caso di successo.

## Contratto v2 — regole da non rompere

- `POST external/v2/notifications` riceve `@Body() body: Record<string, unknown>`:
  metatype Object, la ValidationPipe globale lo salta di proposito. La
  validazione (formato + regole per canale + valori contro le capabilities)
  è in `ExternalNotificationsService` via `validateCreateNotification()`, per
  avere `details[].field` con path completo. Non tipizzare quel `@Body()` con
  il DTO: la pipe globale risponderebbe prima con messaggi senza path.
- Regole che dipendono dal canale (presenza/divieto di campi) in
  `channelRuleIssues()`, MAI come decorator sulla proprietà: `@IsOptional()`
  salta tutti i validatori quando il valore manca, quindi un "obbligatorio per
  SEND" scritto come decorator non scatta mai.
- Campagne API marcate `channelConfig.source = 'external'`, MAI
  `wizSingleMode`: quel flag salta il check INAD al lancio, l'API deve
  dirottare come il lancio UI. Per i controlli "un solo destinatario" usare
  `isSingleRecipientFlow()`.
- Indirizzo e pagamento passano da colonne `extraData` `_ext*`
  (`EXT_COLUMNS` in `external-notification.mapper.ts`) puntate da
  `physicalAddressConfig`/`paymentConfig`.
- Ogni valore enumerato accettato in creazione deve venire da
  `ExternalCapabilitiesService` (stessa fonte di `/capabilities`).
- `notificationId` = `recipient.id`: un futuro endpoint a lotto crea N
  destinatari e riusa `GET /notifications/{id}` invariato.
- `events[].id` = sha1(type|at|data): stabile, base per un futuro webhook.
- Dopo una modifica a `packages/shared-types/src` il `dist` nei container dev
  è vecchio (lo compila `Dockerfile.dev`): ricompilarlo con
  `docker compose exec -w /app <servizio> sh -c "node_modules/.bin/tsc -p packages/shared-types/tsconfig.cjs.json && node_modules/.bin/tsc -p packages/shared-types/tsconfig.esm.json"`
  (backend e frontend), altrimenti import nuovi risultano `undefined`.
