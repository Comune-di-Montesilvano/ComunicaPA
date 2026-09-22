# Campagne & Wizard — ownership, template, INAD routing

## Ownership campagne — cancel()/remove() richiedono requester

`CampaignsService.cancel()`/`remove()` accettano un secondo parametro
`CampaignRequester {username, role}` e chiamano `assertOwnership()`: un
'admin' bypassa sempre, un 'user' solo se `campaign.createdBy ===
requester.username` (altrimenti `ForbiddenException`). Il controller NON
fa il check — lo fa il service, per restare testabile con lo stesso
pattern service-layer già usato per `createdBy` (`campaigns.service.spec.ts`).
Qualunque nuovo metodo mutante su Campaign aggiunto in futuro (oltre a
cancel/remove) va valutato per lo stesso controllo, non solo quello che
lo introduce — stesso principio già in uso per gli stati terminali sopra.

## operator_directory — cache display name, si popola solo al login

`OperatorDirectoryService` mappa username → display name (LDAP reale o
mock), usata da `CampaignsController.findAll()/findOne()` per esporre
`createdByDisplayName` (fallback a `createdBy` grezzo se assente).
Aggiornata SOLO in `AuthService.loginWithLdap()` a ogni login riuscito —
nessun backfill batch, nessuna risoluzione LDAP live per username
arbitrario (richiederebbe un bind service-account che non esiste in
questo codebase). Un operatore che ha creato campagne ma non ha mai
fatto login dopo l'introduzione di questa feature resta con lo username
grezzo finché non fa login una volta.

## Placeholder template notifiche

Delimitatore `%%chiave%%` (doppio `%`, non singolo) — vedi `template.helper.ts`
`processTemplate()`. Un `%` singolo (percentuale in prosa, es. "60% del
tributo") non forma mai un placeholder. Nessuna retrocompatibilità col vecchio
delimitatore singolo: i template esistenti vanno riscritti.

**Ogni valore sostituito in un placeholder HTML va escapato — bug XSS reale
corretto.** `getVal()` in `processTemplate()` (e l'etichetta allegato da
`resolveAttachmentLabel`) sostituivano `recipient.extraData`/campi fissi
SENZA escaping HTML — un CSV destinatari con `<script>`/`<img onerror=...>`
in una colonna finiva verbatim nel body HTML, sia nell'invio reale sia
nell'anteprima admin (`dangerouslySetInnerHTML`, XSS eseguibile nella
sessione dell'operatore). Fix: `escapeHtml()` in `template.helper.ts`
applicata a ogni valore sostituito — MAI al markup del template stesso
(scritto dall'operatore nell'editor rich-text). Qualunque nuovo placeholder/
sostituzione futura deve passare da lì, non reinventare l'escaping altrove
(un tentativo lato frontend era stato scritto ma mai wired — rimosso,
la sanificazione va fatta una sola volta, a monte).

**Oggetto per-destinatario da colonna CSV.** Se `channelConfig.csvMapping.subject`
mappa una colonna, `resolveSubjectTemplate()` (`subject-mapping.util.ts`) usa
il valore di quella cella per il singolo destinatario al posto dell'oggetto
di campagna — utile per invii con tributi diversi nello stesso lancio (es.
SEND), ma significa che editare l'"Oggetto" della campagna nel wizard NON
cambia l'oggetto reale per righe con quella colonna valorizzata. Verificare
sempre `csvMapping.subject` prima di dare per scontato quale oggetto verrà
usato per un destinatario specifico.

**App IO — vincolo di lunghezza anche sull'oggetto**, non solo sul body:
PagoPA rifiuta `content.subject` fuori dal range `[10, 120]` caratteri
(oltre al vincolo già noto su `content.markdown`, `[80, 10000]`) — HTTP 400
"not a valid [string of length >= 10 and < 121]". Validazione bloccante
lato wizard: `wizAppIoSubjectLenInvalid`/`APP_IO_SUBJECT_MIN`/`_MAX`
(`App.tsx`), stesso pattern del check body esistente
(`wizAppIoBodyLenInvalid`).

**Check di "campo vuoto" su testo HTML deve stripare i tag PRIMA di
contare, non solo il vincolo di lunghezza.** Il wizard usa
`isWizBodyEmpty()`/`.trim()` post-strip-HTML per decidere se un
subject/body è vuoto — un check basato su `value.length === 0` grezzo (o
solo `.trim()` senza strip HTML) accetta `"   "` come subject valido o
`"<p></p>"` come body valido, che il wizard rifiuterebbe. Stessa funzione
di strip va riusata sia per il bound di lunghezza sia per l'emptiness
check — bug reale corretto: le due cose erano state implementate con
criteri diversi.

## Wizard campagne — sync bozza/Recipient anticipato ad ogni "avanti"

Dallo step2 in poi, ogni transizione "avanti" (bottoni, tab-click forward,
"Avvia Test") chiama `syncWizDraftAndRecipients(targetStep)` — salva
nome/config/CSV grezzo bozza e, se cambiati dall'ultimo sync (impronta
`wizRecipientsSyncFingerprint`), risincronizza i `Recipient` in DB (via
`uploadCsv()`, delete+recreate). Questo perché i `Recipient` ora esistono
già in bozza (non solo al lancio reale) — necessario perché
`finalizeAttachments()` risolva correttamente gli allegati referenziati a
step5, prima solo Recipient assenti in bozza causavano lo scarto di ogni
allegato caricato.

**`targetStep` va sempre passato esplicitamente, mai desunto da `wizStep`
state.** `buildWizChannelConfigDraft(targetStep)` scrive `wizStep:
targetStep` nel channelConfig persistito — se un punto di chiamata usasse
`wizStep` (stato del render corrente) invece del target, salverebbe lo
step di PARTENZA della transizione, non quello di arrivo (setState non è
visibile nello stesso render/closure). Bug reale già capitato una volta
per lo stesso motivo su una diversa funzione in questo file (vedi bug1
mappatura CSV, stale closure).

**Ogni nuovo bottone/azione che avanza lo step deve chiamare
`syncWizDraftAndRecipients(targetStep)` prima di `setWizStep`.** Bug reale:
"Avvia Test" (step6→7) inizialmente non lo faceva — se l'operatore
modificava oggetto/testo a step4 e tornava a step6 senza mai ripassare da
un bottone "avanti", il test partiva con `channelConfig` ancora quello
del salvataggio precedente mentre l'anteprima mostrava già il nuovo
contenuto in locale — invii "sfalsati" di un edit rispetto alla preview.

**`handleWizSingleSubmit` — mai leggere `wizValidRows`/`wizAttachments`
subito dopo averli appena calcolati nello stesso tick.** `wizValidRows` è
popolato da un `useEffect` separato che reagisce a `wizCsvRows` — se
`syncWizDraftAndRecipients` viene chiamato subito dopo `parseCsvFile()`
(stessa esecuzione sincrona di `handleWizSingleSubmit`), legge ancora
`wizValidRows` di PRIMA (vuoto al primo invio): il gate
`wizValidRows.length > 0` salta la creazione del `Recipient`, e l'allegato
caricato subito dopo viene scartato da `finalizeAttachments` perché
nessun recipient lo referenzia ancora ("Allegato non trovato",
riproducibile anche in un invio lineare senza mai tornare indietro). Fix
applicato: `syncWizDraftAndRecipients`/`buildWizChannelConfigDraft`
accettano un override esplicito (CSV blob + lista allegati) invece di
affidarsi allo stato asincrono per questa chiamata specifica.

**Gating navigazione tab:** `wizMaxReachedStep` (più alto step raggiunto)
+ snapshot `wizLastSyncedHeaders`/`wizLastSyncedMapping` (presi solo al
sync 3→4, quando la mappatura è confermata) determinano se un tab-step
oltre lo step 3 è cliccabile in avanti — solo se CSV/mappatura non sono
cambiati dall'ultimo sync. Il tab bar esistente (`App.tsx` "Steps
Progress Header") permetteva SOLO click all'indietro prima di questa
modifica — non dare per scontato che un salto in avanti "funzioni già".

**`wizSingleMode` per SEND/POSTAL salta lo step Template — il gate reale
per subject/body vive allo step finale, non al gate "Riepilogo".**
`wizSingleNeedsTemplateStep = channel==='EMAIL'||'PEC'||'APP_IO'`
(`App.tsx:1855`) esclude SEND/POSTAL dallo step Template in modalità
singola — il gate step4 "Riepilogo" (`~10455-10469`) non viene MAI
raggiunto per questi due canali. Il gate realmente eseguito è quello dei
bottoni finali "Avvia Test"/"Conferma" (`~11021`/`11029`):
`wizSingleMode && !wizSingleNeedsTemplateStep && !wizSubject.trim()` —
incondizionato, nessun legame con altre opzioni del canale. Bug reale
corretto: un'implementazione basata sul gate step4 aveva reso `subject`
erroneamente opzionale per POSTAL.

## Wizard — bottoni "Avanti"/"Indietro" duplicati in cima e in fondo allo step

Molti step del wizard hanno lo stesso bottone (con la stessa condizione
`disabled`/`onClick`) ripetuto due volte: uno sopra il contenuto dello
step, uno sotto. Le due copie NON sono un unico source-of-truth — sono
letteralmente due blocchi JSX separati che vanno tenuti sincronizzati a
mano. 4 bug reali nella stessa sessione per lo stesso motivo (una copia
aggiornata, l'altra dimenticata): bottone "Riepilogo" (check placeholder
allegati mancante in una sola delle due copie), "Indietro" da step6
(target step corretto in una sola copia), gate tassonomia SEND
obbligatoria (mancante in 2 copie su 3 incluso `wizSingleSubmitDisabled`).
Ogni modifica a una condizione disabled/onClick di questi bottoni va
cercata e applicata a TUTTE le occorrenze (`grep` sul testo della
condizione, non fidarsi di trovarne una sola).

## Creazione campagne — un solo percorso

La creazione/import destinatari passa **solo** dal wizard multi-step
(`view === 'invio-massivo-wizard'` in `frontend-admin/App.tsx`): è l'unico
punto con le validazioni corrette (formato CF/email, lunghezza minima body
App IO). Non aggiungere form di creazione rapida o importer CSV alternativi
altrove (es. sulla pagina dettaglio campagna) — bypassano quelle validazioni
e hanno già causato invii falliti in produzione (CF troncato, markdown vuoto
per App IO). Per riprendere una bozza: bottone "Riprendi wizard"
(`handleResumeDraft`), non un importer dedicato.

## Stato business null vs attempt fallito pre-provider — gotcha

Per i canali con stato business esterno (`sendStatus`/`postalStatus`, SEND
via PN, POSTAL via GlobalCom), un attempt fallito PRIMA di raggiungere il
provider (`AttemptStatus.FAILED`, mai un IUN/IDPRO assegnato) lascia quel
campo a `null` per sempre — indistinguibile da "non ancora processato" in
barre di stato e CSV export, a meno di controllare esplicitamente
`attempt.status === AttemptStatus.FAILED` e sovrascrivere con un valore
sentinella (es. `'FAILED'`) prima di passare il valore a label/breakdown.
Bug reale corretto su `getSendStatusBreakdown`/`getSendReportRows`/
`getPostalStatusBreakdown`/`getPostalReportRows` (`campaigns.service.ts`) —
replicare lo stesso controllo per ogni nuovo canale che aggiunge un
breakdown/report basato sullo stato esterno.

## INAD — override canale per-recipient, gotcha critico

`NotificationAttempt.channelType` è la fonte di verità sul canale REALE di
un destinatario, non `campaign.channelType` — un override INAD (domicilio
digitale trovato) lo dirotta a PEC anche se la campagna è EMAIL/POSTAL/
APP_IO, scrivendolo sull'attempt al momento della creazione. Qualunque
punto che re-instrada/riprova/riporta "per canale" deve leggere
`attempt.channelType` (o l'ultimo attempt del destinatario), MAI
`campaign.channelType` — 3 bug reali corretti nella stessa giornata per
questo esatto errore: `protocollazione.processor.ts` (re-accodava sul
canale di campagna dopo la protocollazione, vanificando il dirottamento),
`retryRecipient()` (stesso errore su un retry manuale), `getSendStageCounts()`
(filtrava `attempt.channel_type = campaign.channelType`, escludendo i
dirottati dal widget "Stato Protocollazione" — sembravano mai protocollati
anche quando lo erano).

**Quarta istanza trovata in sessione successiva**: `getRecipientStats()`
(lista "Destinatari Caricati") filtrava allo stesso modo su
`channelType: campaign.channelType` — un dirottato mostrava sempre "—" su
protocollo/iun/stato consegna anche quando il dato esisteva davvero in DB.
Query su attempt per "ultimo tentativo per destinatario" non deve MAI
filtrare su channelType, punto.

**Quinta istanza — opposta stavolta, non un filtro sbagliato ma un'esclusione
totale**: `getPostalStatusBreakdown`/`getPostalDeliveryStatusBreakdown`
escludevano DEL TUTTO i destinatari dirottati INAD (mai un `postal_status`
reale, filtrati a monte) — "Totale" nei grafici ("Andamento Invio POSTAL",
"Stato Documento", "Recapito Poste") disallineato dal conteggio reale
destinatari, nessuna indicazione che esistessero. Fix: bucket dedicato
`DirottatoAPec` (mai `null`/escluso), stesso principio già in uso per
`AppIoSostituito`/`NonTracciato`. Il filtro sul flag va fatto direttamente
su `Recipient.inadCheck.diverted` (mai un valore reale su
`notification_attempts.postal_status`/`postal_delivery_status`, l'attempt
di un dirottato è su PEC non POSTAL) — sia per il conteggio in
`getRecipientFilterOptions` sia per il filtro vero e proprio in
`getRecipientStats`.

**Priorità tra override**: se un destinatario è dirottato da INAD, l'App IO
esclusiva (che salterebbe il canale primario) viene declassata a parallela
SOLO per quel destinatario — INAD è fonte di verità assoluta sul domicilio
digitale, non bypassabile da un'esclusiva App IO (`notification.processor.ts`).

`Recipient.inadCheck.found` (INAD ha trovato un domicilio) ≠ `.diverted`
(l'indirizzo trovato è REALMENTE diverso da quello già configurato — per
una campagna PEC con indirizzo INAD coincidente, `found:true` ma
`diverted:false`, non è un vero dirottamento). Le decisioni di
instradamento/reporting vanno sempre su `diverted`, mai su `found` da solo.

**Portando questa logica su un nuovo path (es. sync→async), copiare la base di confronto ESATTA per `diverted`,
mai riderivarla "a logica".** `diverted` confronta SEMPRE `recipient.pec` grezzo, indipendente dal canale
campagna — non `originalAddress` (campo solo-audit, per canali non-PEC è `recipient.email`, coincide con
`recipient.pec` per puro caso solo quando il canale È PEC). I due campi sembrano intercambiabili ma non lo sono:
estendendo il check al percorso async per Registro Imprese (job BullMQ per PIVA), la tentazione naturale era
confrontare contro `originalAddress` — avrebbe cambiato silenziosamente il comportamento esistente. Diff riga per
riga contro l'originale quando si porta business logic su un path parallelo, non riscrivere "equivalente".

**Eccezione al comportamento sopra — campagna PEC su PIVA (Registro
Imprese): `diverted` NON auto-applica più `recipient.pec`.** Solo per
`campaign.channelType === 'PEC'` + PIVA + `diverted:true`, il destinatario
va in `RecipientStatus.PENDING_REVIEW` (PEC trovata salvata in
`inadCheck.foundAddress`, mai scritta su `recipient.pec`) invece
dell'auto-apply — INAD su persona fisica e lo switch di canale
EMAIL/POSTAL/APP_IO→PEC restano auto-applicati come sempre. Motivo: una
PEC "tributi@..." espressamente dedicata su file non va persa in favore
di quella generica del Registro Imprese senza che l'operatore se ne
accorga. Pannello "PEC difformi da verificare" in dettaglio campagna,
risoluzione via `resolvePecReview()` (due scelte: mantieni su file / usa
trovata, entrambe sbloccano l'invio per quel solo destinatario — il resto
della campagna procede regolarmente, mai un blocco sull'intera campagna).

## Setting globale che condiziona una campagna — inferire "è girato?" dai dati, mai assumere 0 = mai eseguito

`inad.checkEnabled` è un `AppSettingsService` globale, non salvato su
`channelConfig` — a posteriori un `inadDiverted: 0` è ambiguo ("mai
controllato" vs "controllato, nessun dirottamento", ambiguità reale
segnalata dall'operatore in UI). `getChannelBreakdown()` deriva
`inadCheckRan` da "almeno un destinatario ha `inadCheck` popolato" —
stesso principio per qualunque altro setting globale non persistito
per-campagna: inferire l'esecuzione dal side-effect sui dati, mai dal
solo conteggio a zero.

## Matrice comportamenti campagne per canale — fonte di verità

Riferimento completo, verificato contro il codice (non contro il manuale):
[`docs/superpowers/specs/2026-07-17-matrice-comportamenti-campagne-design.md`](docs/superpowers/specs/2026-07-17-matrice-comportamenti-campagne-design.md).
Consultare PRIMA di modificare comportamento canale/INAD/App IO
secondaria/protocollo/allegato/contenuto testuale — evita di reintrodurre
un caso già verificato o di romperne uno esistente. Per obbligatorietà e
vincoli di `subject`/`body` per canale (wizard singolo — attenzione, il
gate reale per SEND/POSTAL non è quello più visibile, vedi sezione "Wizard
campagne" sopra), doc dedicato:
[`docs/superpowers/specs/2026-08-11-regole-subject-body-canale-design.md`](docs/superpowers/specs/2026-08-11-regole-subject-body-canale-design.md).

Riassunto (dettaglio riga-per-riga nel file linkato):

| Canale | App IO secondaria | INAD | Protocollo | Allegato | Contenuto (subject/body) |
|---|---|---|---|---|---|
| EMAIL | none/parallela/esclusiva¹ | sì → `channelType`=PEC + `recipient.pec`=indirizzo INAD | opzionale | opzionale | subject+body obbligatori |
| PEC | none/parallela/esclusiva¹ | sì, se PEC INAD diversa → solo `recipient.pec` sovrascritto (stesso canale) | opzionale | opzionale | subject+body obbligatori |
| POSTAL | none/parallela/esclusiva¹ | sì → `channelType`=PEC + `recipient.pec`=indirizzo INAD (skip stampa) | opzionale | **obbligatorio** | subject obbligatorio, body **rifiutato** |
| APP_IO | n/a | sì → `channelType`=PEC, ma App IO **resta inviato in parallelo** (mai skip)² | opzionale | opzionale | subject [10,120] + body [80,10000] obbligatori |
| SEND | n/a (`isMailChannel` esclude SEND) | n/a (PN risolve da sé) | **obbligatorio** | **obbligatorio** | subject obbligatorio, body **rifiutato** |

¹ esclusiva → declassata a parallela per singolo destinatario se `diverted:true` (INAD vince sempre).

² Diverso da POSTAL: POSTAL ha un costo reale per invio, quindi il
dirottamento salta intenzionalmente la stampa (risparmio). App IO è
gratuito — nessun motivo per escluderlo quando è il canale primario, va
sempre inviato in aggiunta alla PEC dirottata (`notification.processor.ts`,
`isPrimaryAppIoDivertedToPec`/`parallelAppIoApiKey`), non al posto di.

Se aggiungi un nuovo canale, un nuovo asse (es. verifica toponomastica
POSTAL, oggi non implementata) o cambi una di queste regole: aggiorna
PRIMA il file linkato, poi il codice — è la fonte di verità che evita di
dover rileggere 5 file diversi per capire "cosa succede se combino X con Y".

