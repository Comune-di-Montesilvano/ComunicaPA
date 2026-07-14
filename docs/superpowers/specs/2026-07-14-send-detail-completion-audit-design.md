# Audit pipeline SEND: completamento campagna, dettaglio notifica, wizard — Design

Data: 2026-07-14

## Contesto

Dopo il refactor "pipeline a demoni" (sotto-progetto precedente, stesso giorno:
`docs/superpowers/specs/2026-07-14-pipeline-demoni-send-design.md`), SEND non
passa più da BullMQ/`notification.processor.ts` ma da `SendDispatchService`
(demone `@Cron`). Questo ha lasciato scoperti alcuni punti che il vecchio
flusso copriva solo per gli altri 4 canali. Audit richiesto dall'utente dopo
aver notato: campagna SEND locale resta "In coda" nonostante l'unica notifica
sia stata inviata con successo; il dettaglio notifica non mostra IUN,
protocollo, stato SEND né data; il wizard di creazione campagna richiede un
"Corpo del Messaggio" anche per SEND, dove non è mai usato.

## Problemi (audit)

**A. Campagna SEND non si completa mai.**
`checkAndCompleteCampaign()` (`notification.processor.ts:284-296`) marca la
campagna `COMPLETED` quando non restano destinatari `PENDING`/`QUEUED`, ma
vive solo lì — chiamata solo dal flusso BullMQ. `SendDispatchService.
markSuccess()`/`markFailed()` (`send-dispatch.service.ts:221-258`) aggiornano
`recipient.status` e i contatori campagna ma non chiamano mai questo check:
una campagna SEND resta `QUEUED` per sempre, anche a invio (e fallimento)
terminati per tutti i destinatari.

**B. Dettaglio notifica non espone i campi SEND, pur essendo già salvati.**
`NotificationAttempt` ha colonne `iun`, `sendStatus`, `sendStatusUpdatedAt`,
`protocolNumber`, `protocolYear`, `protocolledAt` (popolate da
`SendDispatchService`/`ProtocollazioneSyncService`/`SendStatusSyncService`).
`NotificationsSearchService.getDetail()` (`notifications-search.service.ts:
122-135`) e `AttemptDetailDto` (`dto/notification-detail.dto.ts`) mappano solo
`attemptNumber/status/channelType/errorMessage/sentAt/createdAt/appIo` — i
campi SEND vengono scartati prima di arrivare al frontend.

**C. UI mostra un "messaggio"/anteprima che per SEND non esiste.**
- Dettaglio campagna (`App.tsx:6727-6732`): blocco "Testo Messaggio"
  (`campaign.description`) mostrato per ogni canale, ma per SEND non è mai
  usato per l'invio (SEND manda PDF generato + tassonomia, non un corpo
  testo libero).
- Modal "Dettaglio Notifica" (`App.tsx:4864-4874`): blocco "Anteprima
  Messaggio Inviato" mostra sempre `preview.subject` + `preview.bodyHtml`/
  `bodyMarkdown` — per SEND il body non è mai popolato/usato (vedi punto D),
  quindi il blocco è fuorviante (sembra "manca il messaggio" quando in realtà
  non è mai esistito un messaggio testuale per quell'invio).

**D. Wizard Step 4 obbligatorio anche per SEND, ma il corpo non è mai usato.**
`App.tsx:4303+` (Step 4, "Template & Anteprima"): richiede `wizSubject` +
`wizBody` non vuoto per abilitare "Avanti". `send-dispatch.service.ts` legge
`cfg['subject']` (usato come titolo documento PN) ma non legge mai
`cfg['body']` — il corpo del messaggio è puro attrito per l'operatore SEND,
mai consumato a valle.

**D-bis. Oggetto SEND può variare per destinatario (dubbio emerso durante il
design), non solo per template.** Oggi `wizSubject` è un unico template di
campagna con placeholder (`%%nominativo%%` etc.), stesso per ogni riga. Per
SEND ha senso poter mappare l'oggetto da una colonna del CSV (es. tributi
diversi nello stesso invio), analogo a come `codice_fiscale`/`full_name`/
`email`/`pec` si mappano in Step 3. Decisione utente: mappabile da CSV, con
fallback al template generico quando la colonna non è mappata o la cella per
quella riga è vuota.

**E. Nessuna vista con IUN/protocollo/stato nella tabella destinatari.**
`getRecipientStats()` (`campaigns.service.ts:919-942`) interroga solo
`Recipient` (id/fullName/codiceFiscale/email/pec/status/downloadCount/...),
nessun join su `NotificationAttempt` — i dati SEND non arrivano nemmeno alla
query, a prescindere dal fix B. La tabella "Destinatari Caricati"
(`App.tsx:6912-6946`, click riga → `openNotificationDetail`) mostra solo
Stato Notifica + Download, stesse colonne per ogni canale.

## Fuori scope (annotato per il futuro)

Lo scopo finale per SEND è un report CSV con stato e **data di consegna**
per caricamento in altro gestionale. Oggi `sendStatusUpdatedAt` è "quando
*noi* abbiamo notato l'ultimo cambio di stato" (poll ogni 5 minuti in
`SendStatusSyncService.updateStatuses()`), non la data legale reale
dell'evento PN (es. quando la notifica è diventata `VIEWED`/
`EFFECTIVE_DATE` nel timeline PN — `GET /delivery/v2.9/notifications/sent/
{iun}` oggi legge solo `notificationStatus` piatto, non lo storico eventi
con date). Il gap resta aperto e va richiuso quando si affronta il CSV: non
tocchiamo `send-status-sync.service.ts` in questo giro.

## Architettura

### A. Completamento campagna SEND

Estrarre `checkAndCompleteCampaign(campaignId)` da `notification.processor.ts`
in un metodo pubblico riusabile su `CampaignsService` (stesso servizio che
già inietta `campaignRepo`/`recipientRepo` — nessun nuovo file necessario).
`notification.processor.ts` chiama il metodo spostato invece della propria
copia privata (nessun cambio di comportamento per gli altri 4 canali).
`SendDispatchService.markSuccess()` e `markFailed()` chiamano lo stesso
metodo subito dopo l'update di `recipient.status`/contatori, esattamente
come fa oggi il processor per gli altri canali.

### B. DTO dettaglio notifica

`AttemptDetailDto` (`dto/notification-detail.dto.ts`) aggiunge:
```ts
iun: string | null;
sendStatus: string | null;
sendStatusUpdatedAt: string | null;
protocolNumber: number | null;
protocolYear: number | null;
protocolledAt: string | null;
```
`NotificationsSearchService.getDetail()` li popola dal record `NotificationAttempt`
già caricato (nessuna query aggiuntiva, i dati sono già nell'entity). Per
canali non-SEND questi campi sono sempre `null` (colonne mai scritte) — il
frontend li renderizza solo quando `channelType === 'SEND'` (vedi UI sotto),
nessun impatto visivo sugli altri canali.

### C. UI — nascondere blocchi messaggio irrilevanti per SEND

- `App.tsx:6727-6732`: blocco "Testo Messaggio" avvolto in
  `{campaign.channelType !== 'SEND' && (...)}`.
- `App.tsx:4864-4874`: blocco "Anteprima Messaggio Inviato" per SEND mostra
  solo la riga `Oggetto` (già presente, riga 4865), nasconde
  `bodyHtml`/`bodyMarkdown`/il fallback "Nessuna anteprima disponibile" —
  quel ramo condizionale intero avvolto in
  `{notifDetail.campaign.channelType !== 'SEND' && (...)}`.

### D. Wizard Step 4 ridotto per SEND

`App.tsx:4303+`, dentro `wizStep === 4`: quando `wizChannel === 'SEND'`,
nascondere il blocco "Corpo del Messaggio" (`TemplateEditor` + relativi
placeholder e il warning `wizAppIoBodyLenInvalid`, che non si applica a
SEND). Titolo step adattato a "Passo 4: Oggetto della Comunicazione". Il
bottone "Avanti" per SEND resta abilitato in base al solo `wizSubject`
(`disabled={!wizSubject}`, senza `isWizBodyEmpty(wizBody)` né
`wizAppIoBodyLenInvalid` che non lo riguardano). Per tutti gli altri canali,
comportamento invariato.

### D-bis. Oggetto mappabile da colonna CSV (solo SEND)

- `wizMapping` (`App.tsx:455-461`) guadagna un campo opzionale
  `subject: ''` (nome colonna CSV), analogo a `email`/`pec`. Popolato in
  Step 3 (stesso blocco UI dei mapping esistenti, riga ~3981-4032: nuovo
  `<select>` "Oggetto (per destinatario, opzionale)" con le colonne CSV
  disponibili + opzione vuota).
- Salvato in `channelConfig` come `subjectColumn: wizMapping.subject`
  (solo se non vuoto), stesso punto dove oggi si salva `csvMapping`
  (`App.tsx:2534`, `:2674-2675`) — non serve un campo nuovo separato dal
  `csvMapping` esistente se `subject` vi rientra già come proprietà.
- Import CSV (`campaigns.service.ts:212-224`, costruzione `extraData`):
  nessun cambio — la colonna oggetto, chiunque sia il suo nome, finisce già
  in `recipient.extraData` come tutte le colonne non riservate
  (`codice_fiscale`/`email`/`pec`/`full_name` sono le uniche escluse).
- `send-dispatch.service.ts` (righe ~118-120): 
  ```ts
  const subjectColumn = cfg['subjectColumn'] as string | undefined;
  const perRecipientSubject = subjectColumn ? (recipient.extraData?.[subjectColumn] as string | undefined) : undefined;
  const subjectTemplate = (perRecipientSubject?.trim() || (cfg['subject'] as string) || campaign.name);
  const subject = interpolate(subjectTemplate, vars);
  ```
  Fallback al template generico se la colonna non è mappata o la cella è
  vuota per quella riga — il valore per-riga passa comunque per
  `interpolate()` (può contenere placeholder come il template).
- Step 4 wizard: il campo "Oggetto" generico (`wizSubject`) resta
  **sempre obbligatorio** anche quando è mappata una colonna per-riga — è
  il fallback, deve esistere un valore di default. Anteprima Step 4 (se
  già mostra un oggetto calcolato per la riga di preview) usa la stessa
  logica fallback per coerenza con l'invio reale.
- Anteprima singolo destinatario (`renderMessageForRecipient`,
  `campaigns.service.ts:123-133`, usata anche dal modal Dettaglio Notifica,
  punto C): stessa logica di fallback, per mostrare l'oggetto realmente
  usato per quel destinatario, non solo il template.

### E. Colonne SEND nella tabella destinatari

`getRecipientStats()` (`campaigns.service.ts:919-942`): quando
`campaign.channelType === 'SEND'`, la query aggiunge un `leftJoin` su
`notification_attempts` filtrato `channel_type = 'SEND'`, prendendo per
ciascun destinatario l'ultimo attempt (`ORDER BY attempt_number DESC` /
`created_at DESC`, primo per destinatario — usare subquery correlata o
`DISTINCT ON` Postgres, non `leftJoinAndSelect` semplice che duplicherebbe
righe con più tentativi). Campi aggiunti al DTO `RecipientStatsPageDto`
(item): `iun`, `sendStatus`, `sendStatusUpdatedAt`, `protocolNumber`,
`protocolYear` — tutti opzionali, `undefined`/assenti per gli altri canali
(nessun cambio di query per loro).

`App.tsx:6912-6946`: quando `campaign.channelType === 'SEND'`, l'header
tabella sostituisce la colonna "Download" con "IUN" / "Protocollo" / "Stato
SEND" / "Aggiornato il" (formato protocollo: `${protocolNumber}/${protocolYear}`
o "—" se non ancora protocollato). Per gli altri canali, tabella invariata
(colonna Download resta). Click riga invariato (`openNotificationDetail`),
beneficia già del fix B.

## Testing

- Unit test `CampaignsService`/metodo di completamento estratto: campagna
  SEND con tutti gli attempt terminali (SUCCESS/FAILED misti) → `COMPLETED`;
  con almeno un `QUEUED` residuo → resta invariata. Test aggiornati per
  `notification.processor.spec.ts` (nessuna regressione sugli altri canali,
  stesso comportamento, chiamata delegata al metodo condiviso).
- Unit test `SendDispatchService`: `markSuccess`/`markFailed` chiamano il
  completamento campagna (mock verificabile), guardia già esistente
  (update solo se ancora `QUEUED`) invariata.
- Unit test `NotificationsSearchService.getDetail()`: attempt SEND con
  iun/sendStatus/protocollo popolati → DTO li riporta; attempt altro canale
  → DTO ha quei campi `null` (nessuna regressione sui payload esistenti).
- Unit test `getRecipientStats()`: campagna SEND con destinatario che ha 2
  attempt (uno FAILED vecchio, uno SUCCESS più recente con iun) → riga
  ritorna i dati dell'ultimo attempt, non duplica righe.
- Unit test `send-dispatch.service.ts`: `subjectColumn` configurato e cella
  valorizzata → usa il valore per-riga (interpolato); `subjectColumn`
  configurato ma cella vuota per quella riga → fallback al template
  generico; `subjectColumn` non configurato → comportamento invariato
  (solo template).
- Verifica manuale UI: wizard SEND step 4 mostra solo Oggetto, procede senza
  corpo; dettaglio campagna SEND non mostra "Testo Messaggio"; tabella
  destinatari SEND mostra IUN/Protocollo/Stato; modal dettaglio notifica SEND
  mostra Storico Tentativi con le colonne SEND e Anteprima con solo
  l'Oggetto; campagna SEND locale esistente (menzionata dall'utente) passa
  da `QUEUED` a `COMPLETED` dopo il prossimo giro di
  `SendStatusSyncService`/riavvio backend con il fix applicato (o via script
  manuale di backfill se serve sistemare lo stato bloccato oggi in DB — da
  verificare in fase di implementazione se serve una query di backfill
  una-tantum sulle campagne già bloccate in `QUEUED`).
- `tsc --noEmit` backend/frontend-admin, `jest --maxWorkers=2` (nessuna
  regressione sui 4 canali BullMQ, invariati).

## File coinvolti

- `apps/backend/src/campaigns/campaigns.service.ts` (nuovo metodo
  completamento condiviso, `getRecipientStats()` join SEND)
- `apps/backend/src/queue/notification.processor.ts` (chiama il metodo
  spostato invece della copia privata)
- `apps/backend/src/channels/send/send-dispatch.service.ts` (chiama il
  completamento in `markSuccess`/`markFailed`; legge `subjectColumn` +
  fallback per l'oggetto per-destinatario)
- `apps/backend/src/campaigns/campaigns.service.ts` (`renderMessageForRecipient`:
  stessa logica fallback oggetto per-destinatario, usata dal modal
  Dettaglio Notifica)
- `apps/backend/src/notifications-search/dto/notification-detail.dto.ts`
  (nuovi campi `AttemptDetailDto`)
- `apps/backend/src/notifications-search/notifications-search.service.ts`
  (mapper `getDetail()`)
- `apps/backend/src/campaigns/dto/recipient-stats-page.dto.ts` (o dove
  dichiarato `RecipientStatsPageDto` — nuovi campi item SEND)
- `apps/frontend-admin/src/App.tsx` (dettaglio campagna: nascondere Testo
  Messaggio per SEND; tabella destinatari: colonne SEND; modal dettaglio
  notifica: colonne SEND in Storico Tentativi, Anteprima solo Oggetto;
  wizard Step 4: corpo nascosto per SEND)

## Backfill campagne già bloccate

La campagna SEND locale dell'utente (già inviata, ancora `QUEUED` in DB) non
si sblocca da sola col solo fix del codice — il fix previene il problema per
i prossimi invii, non corregge lo stato già scritto. Serve, in fase di
implementazione, verificare lo stato attuale e se necessario invocare
manualmente (via query diretta o endpoint esistente) il nuovo metodo di
completamento condiviso per le campagne SEND già bloccate in `QUEUED` senza
destinatari pending — non serve una migration, basta un giro del metodo
condiviso una volta disponibile.
