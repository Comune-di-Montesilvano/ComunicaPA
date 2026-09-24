# SEND — PN (Piattaforma Notifiche)

## SEND — autenticazione reale verso PN, gotcha critico

PN (`api.notifichedigitali.it`/`api.uat.notifichedigitali.it`) richiede
**ENTRAMBI** gli header su ogni chiamata `/delivery/*`: `x-api-key` (emesso
dal portale self-care PN) **e** `Authorization: Bearer <voucher PDND>`.
Lo spec OpenAPI backend (`components.securitySchemes`) documenta SOLO
`x-api-key` — non descrive il layer di gateway PDND davanti al backend
reale. Verificato solo contro l'esempio curl verbatim della guida ufficiale
(developer.pagopa.it, "Inserimento notifica con il comando curl"), non
fidandosi dello spec YAML da solo. Un solo header → 403/401.

**Upload allegati**: `x-amz-checksum-sha256` sull'URL S3 presigned va come
header HTTP normale, MAI come trailer chunked — un trailer produce
`SignatureDoesNotMatch` (la firma dell'URL presigned assume il checksum tra
gli header firmati). Vedi `send-attachment-upload.service.ts`.

**Payload `documents[].docIdx`**: deve essere stringa (`"0"`), non numero
— lo schema PN è `allOf` di 2 sotto-schemi e un numero fa fallire la
validazione con un errore criptico ("matched only 1 out of 2").

**Campi opzionali ma a volte obbligatori**: `physicalAddress` (destinatario)
è richiesto se PN non risolve un domicilio digitale legale (es. CF non
trovato su ANPR/INAD) — errore "PhysicalAddress cannot be null". `group`
(root payload) è richiesto se l'account PN è associato a più gruppi utenti
(self-care PN) — errore "Specify a group in cx_groups=[...]". Entrambi
configurabili via Impostazioni → SEND, nessun default hardcoded.

**`group` può diventare obbligatorio da un giorno all'altro senza alcuna
modifica di codice — drift di configurazione lato PN, non regressione
nostra.** Un account con un solo `cx_group` non richiede `group` nel
payload (comportamento corretto, campo omesso); se sul portale self-care
PN viene aggiunto un secondo gruppo all'account, PN inizia a rifiutare
con `PN_DELIVERY_INVALIDPARAMETER_GROUP`/"Specify a group in
cx_groups=[...]" invii che fino al giorno prima passavano — incidente
reale il 2026-09-08 (nessun commit toccava SEND/`group` da settimane).
L'errore stesso include l'id del gruppo valido da usare — bastava
incollarlo in Impostazioni → SEND → Gruppo PN (env corretto) e salvare
(submit dell'intero form, non basta selezionare dal dropdown — vedi
gotcha "Salva Impostazioni" sotto).

**Bottone "Carica gruppi" (`GET admin/settings/send/:env/groups`) può
dare 403 anche con apiKey/voucher validi per l'invio — verificato che
NON è correlato al numero di gruppi dell'account.** Spec raw
(`pagopa/pn-external-registries`, `docs/openapi/
pn-selfcare-external-v1.yaml`, endpoint `/ext-registry-b2b/pa/v1/groups`,
security `ApiKeyAuth` solo `x-api-key`, esattamente quello che il nostro
codice manda) documenta solo risposte `200`/`400`/`500` — **mai 403** —
e l'implementazione Java reale (`InfoPaController.getGroupsB2B` /
`InfoSelfcareGroupsService`) non ha alcuna logica sul conteggio gruppi:
un account a gruppo singolo torna 200 con la lista, non 403. Un 403 non
documentato nello spec applicativo arriva quindi PRIMA del codice PN
vero e proprio — livello gateway/API Manager che autorizza le chiamate
in ingresso per quell'apiKey su quello specifico path, non la UI
self-care PN (quella gestisce solo business config: gruppi/ruoli
utente — coerente col fatto che lì non si vede alcuna opzione di
"permesso"/scope per l'apiKey). Non fixabile da codice: header/query
param (`x-api-key`, `statusFilter`) già combaciano esatti con lo spec.
Verificato dal vivo (`send-status-sync`/`send-dispatch` OK su
`/delivery/*`, `getSendGroups` 403 su `/ext-registry-b2b/*` con la
STESSA apiKey) l'8-9 settembre 2026. Workaround sempre disponibile:
l'id del `cx_group` richiesto arriva comunque nell'errore
`PN_DELIVERY_INVALIDPARAMETER_GROUP` di un invio fallito — inseribile a
mano nel campo, nessun bisogno del bottone. Se serve davvero "Carica
gruppi" funzionante, va aperta segnalazione al supporto PN — non
un'azione self-service disponibile in self-care, causa non ancora
identificata con certezza oltre "livello gateway, non applicativo".

**Un errore che finisce solo nei log del demone `@Cron`, mai su
Sentry/GlitchTip — gap reale corretto (PR #43, 2026-09-09).**
`send-dispatch.service.ts`/`send-status-sync.service.ts` (SEND) e
`postal-status-sync.service.ts` (POSTAL) girano fuori da BullMQ (vedi
"pattern jobId = attemptId" sopra) — i loro `catch` non passano MAI da
`notification.processor.ts`, l'unico punto che chiamava
`captureException`. Un 400 reale verso PN (incluso questo stesso
incidente `group`) restava quindi invisibile su GlitchTip, solo `logger.warn`
nei log del container. Fix: `captureException` aggiunto in ogni catch di
quei tre file. Qualunque futuro demone `@Cron` channel-agnostico che
bypassa BullMQ va verificato per lo stesso gap prima di considerarlo
"osservabile allo stesso modo" del resto della pipeline.

**Verifica spec**: mai fidarsi di un riassunto AI dello spec OpenAPI —
scaricare il raw YAML (`curl` su `pagopa/pn-delivery`, `docs/openapi/
api-external-b2b-pa-bundle.yaml` — NON `pn-openapi-devportal`, repo
inesistente/404) e grep diretto su `securitySchemes`/
schema dei singoli campi. Un riassunto ha già portato a un fix sbagliato
una volta in questa stessa giornata di debug.

**Trovare il file giusto tra i repo PagoPA**: `gh search code "<termine>"
--owner pagopa` (richiede `gh` autenticato) batte `WebFetch`/ricerca
GitHub web per individuare quale repo/file OpenAPI/implementazione Java
contiene un endpoint — una `WebFetch` diretta su un path indovinato ha
dato 404 o un riassunto fuorviante una volta in questa sessione;
`gh search code` ha trovato il file corretto (`pn-selfcare-external-v1.yaml`)
al primo colpo e permesso di leggere anche l'implementazione Java reale
per confutare un'ipotesi sbagliata sul 403 di `/ext-registry-b2b/*`.

## SEND — stati notifica PN (sendStatus)

`sendStatus` (colonna `NotificationAttempt`, popolata da
`SendStatusSyncService` da `GET /delivery/v2.9/notifications/sent/{iun}`)
usa l'enum `NotificationStatusV26` dello spec ufficiale PN (repo
`pagopa/pn-delivery`, `docs/openapi/api-external-b2b-pa-bundle.yaml`):
11 valori — `IN_VALIDATION`, `ACCEPTED`, `REFUSED`, `DELIVERING`,
`DELIVERED`, `VIEWED`, `EFFECTIVE_DATE`, `PAID` (deprecato), `UNREACHABLE`,
`CANCELLED`, `RETURNED_TO_SENDER`. Attenzione alla versione:
`RETURNED_TO_SENDER` esiste solo in V26, non nelle versioni più vecchie
dello schema `NotificationStatus` — verificare sempre lo spec raw, non un
riassunto, prima di aggiungere/rimuovere valori da `TERMINAL_STATUSES`
(`send-status-sync.service.ts`) o da `SEND_STATUS_META` (`App.tsx`).


## SEND — costo cartaceo (analogCost) arriva DOPO il primo calcolo

Il costo SEND (`paFee` + somma `analogCost` degli eventi
`SEND_ANALOG_DOMICILE`/`SEND_SIMPLE_REGISTERED_LETTER` della timeline) era
calcolato una sola volta (`costCents === null`), alla prima sync dopo
`ACCEPTED` — ma l'evento cartaceo compare minuti/giorni dopo, insieme al
passaggio a `DELIVERING` (verificato su IUN reale: ACCEPTED 11:26, analogCost
493 alle 11:30). Risultato: tutte le SEND in prod ferme a 1€. Ora
`SendStatusSyncService` ricalcola se l'analogCost in timeline differisce da
quello salvato e ripesca i terminali con `cost_calculated_at <
send_status_updated_at` (auto-recupero dei record già chiusi dopo il deploy).
Importi al netto IVA (PN espone `vat` a parte). Script debug:
`docker compose exec backend node src/debug/send-notification-costi.cjs <IUN>`
(stampa solo stato/timeline/costi, nessun dato personale).
