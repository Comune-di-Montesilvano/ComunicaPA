# Invio notifica di prova nel wizard campagne

Data: 2026-07-19

## Problema

L'operatore che configura una campagna massiva (wizard `invio-massivo-wizard`)
non ha modo di verificare l'esito reale dell'invio (contenuto email/PEC
renderizzato, notifica App IO ricevuta, esito SEND su portale PN, esito
POSTAL su backoffice GlobalCom) prima di lanciare la campagna vera su tutti
i destinatari. Serve un "invio di prova": stesso motore di invio reale, ma
verso un CF/destinazione scelti dall'operatore (es. il proprio), derivato
dal primo record del CSV caricato.

## Struttura wizard aggiornata

Il wizard passa da 5 a 7 step:

1. Dettagli & Canale (invariato)
2. Caricamento File — CSV destinatari (invariato)
3. Mappatura & Validazione (invariato)
4. Template & Anteprima (invariato)
5. **Upload Allegati (nuovo)** — step dedicato: gli allegati vengono
   caricati (chunked) verso `/campaigns/:id/attachments/upload`
   **immediatamente in questo step**, non più differiti al lancio finale.
   Se la campagna non è ancora persistita come DRAFT, viene salvata
   entrando in questo step (stesso pattern di `handleSaveWizardDraft`).
6. **Anteprima e Invio (ex step 5 "Riepilogo & Invio")** — anteprima per
   singolo destinatario (riuso componente preview di step 4). Due bottoni:
   - **Avvia Campagna**: comportamento di `handleWizLaunch` invariato,
     meno l'upload allegati (già fatto allo step 5).
   - **Avvia Test**: naviga allo step 7.
7. **Test (nuovo)** — form CF + campo/i destinazione (per canale, vedi
   sotto), precompilato dal primo record di `wizValidRows`. Mostra anche
   lo storico degli invii di prova già effettuati per questa bozza
   (appesi, non sovrascritti). Bottone "Invia" crea un nuovo invio di
   prova. Bottone "Indietro" torna allo step 6.

Motivazione dello spostamento upload allegati: permette al backend, al
momento del test, di copiare allegati già persistiti sul server (nessun
upload aggiuntivo da stato browser, nessuna richiesta di riselezione
file). Il CSV destinatari resta con upload differito al lancio reale
(invariato) — il test non ne ha bisogno, usa direttamente il primo
record già presente in memoria (`wizValidRows[0]`) passato nel body
della request.

## Campi editabili per canale (step 7)

| Canale | Campi oltre a CF |
|---|---|
| EMAIL | indirizzo email |
| PEC | indirizzo PEC |
| POSTAL | indirizzo, comune, CAP, provincia (tutti obbligatori) |
| SEND | nessuno (PN risolve il domicilio digitale dal CF) |
| APP_IO | nessuno (consegna app associata al CF) |

Validazione CF: stesso regex già usato in step 3. Email/PEC: stessi
validatori già esistenti nel wizard. POSTAL: tutti e 4 i campi
obbligatori (coerente col fatto che l'allegato è già obbligatorio su
questo canale — un test postale senza destinazione completa non ha
senso). Bottone "Invia" disabilitato finché i campi richiesti dal
canale non sono validi.

## Modello dati

Nuovi campi su `Campaign`:
- `isTest: boolean` (default `false`)
- `parentCampaignId: uuid | null` (FK self-reference, nessun
  `onDelete: CASCADE` — la cancellazione è gestita esplicitamente, vedi
  sotto)

Nessun nuovo valore in `CampaignStatus`: la campagna test resta in
`QUEUED` per tutta la sua vita (può accogliere più invii di prova nel
tempo, non ha un ciclo DRAFT→QUEUED→COMPLETED come una campagna
normale). `isTest=true` esclude sempre la campagna da
`CampaignCompletionService.checkAndComplete()` — non completa mai da
sola.

Allegati della campagna test: **copia fisica separata**, non
riferimento ai file della madre. Cartella dedicata
`uploads/<testCampaignId>/`, `AttachmentConfigEntry[]` proprio del
child. Motivo: isola completamente il lifecycle — la retention/
cancellazione della campagna test non deve mai poter toccare i file
della bozza madre, indipendentemente da quanto la bozza resti aperta
prima del lancio reale (le bozze DRAFT non hanno mai
`Recipient.attachmentExpiresAt` valorizzato, quindi la retention
standard non le tocca mai — ma un invio di prova È un invio reale, il
suo `Recipient` prende `attachmentExpiresAt` normale a invio riuscito/
fallito).

## Backend — endpoint e flusso

Nuovo endpoint `POST /admin/campaigns/:id/test-send`, body:
```json
{ "codiceFiscale": "...", "email"?: "...", "pec"?: "...",
  "postalAddress"?: "...", "postalMunicipality"?: "...",
  "postalZip"?: "...", "postalProvince"?: "...",
  "recipientData": { /* resto del primo record wizValidRows[0],
                        per mantenere coerenti i placeholder template */ } }
```

`campaigns.service.ts`, nuovo metodo `launchTestSend(campaignId, dto)`:

1. Carica campagna madre (`:id`). Trova child esistente
   (`parentCampaignId = :id, isTest = true`) o ne crea uno nuovo
   (`isTest: true`, `parentCampaignId: :id`, stesso `channelType` della
   madre, stato iniziale `QUEUED`).
2. Copia (server-to-server, `fs.copyFile`) gli allegati correnti della
   madre da `uploads/<madre.id>/` verso `uploads/<child.id>/` —
   sovrascrivendo eventuali copie precedenti (riflette sempre l'ultima
   versione allegati caricata dalla madre). Aggiorna
   `AttachmentConfigEntry[]` del child.
3. Copia `channelConfig` della madre nel child (snapshot corrente:
   subject/body/taxonomy/mailConfigId/ecc — riflette sempre le ultime
   modifiche fatte nel wizard prima del test).
4. Crea un `Recipient` sul child con CF e campo/i destinazione
   sovrascritti dal body, resto dei dati da `recipientData` (per
   coerenza placeholder template).
5. Riusa le stesse validazioni di `launch()` (allegato obbligatorio per
   SEND/POSTAL, `channelConfig.protocolla` obbligatorio per SEND) —
   estratte in funzione condivisa per garantire comportamento identico
   al lancio reale. Nessun check INAD (il CF di test è scelto
   dall'operatore proprio per bypassare l'INAD reale).
6. `createAttemptsAndEnqueue()` con singolo elemento — stesso enqueue,
   stesso motore, stessa strategy di canale della campagna reale.
7. Risposta con `attemptId` (per eventuale polling stato in step 7,
   pattern 200+`{blocked:true,message}` per errori "previsti" dietro il
   reverse proxy).

Ogni invio di prova successivo ripete 1-6 sullo stesso child esistente:
nuovo `Recipient`+`NotificationAttempt` appeso, storico precedente
conservato (mai sovrascritto), visibile in step 7 e nel dettaglio della
campagna test.

## Cancellazione automatica

Quando la campagna madre raggiunge `COMPLETED` (fine invio reale, non
al click "Avvia Campagna" — così restano possibili verifiche/test anche
durante l'invio in corso), hook in `CampaignCompletionService`: se
esiste un child (`parentCampaignId = madre.id`), cancella a cascata
`NotificationAttempt` + `Recipient` + `Campaign` del child, rimuove
`uploads/<childId>/` da disco, best-effort remove di eventuali job
BullMQ pendenti del child (stesso pattern di `cancel()`).

Stesso hook va agganciato anche alla cancellazione esplicita (DELETE)
della campagna madre prima che raggiunga `COMPLETED` — non solo al
percorso di completamento naturale.

## UI — lista campagne e dettaglio

`GET /admin/campaigns`: le campagne con `isTest=true` restano visibili
nell'elenco (badge "TEST" + link alla madre via `parentCampaignId`), ma
sono escluse dai contatori/KPI aggregati (dashboard, totali invii).
Dettaglio campagna test: stessa UI di dettaglio normale, nessuna vista
custom — solo il badge a distinguerla.

Lato cittadino (portale citizen, login OIDC con CF di test): nessuna
esclusione — l'invio di prova è un invio reale sul canale reale, deve
comparire come una notifica normale per quel CF.

## Fuori scope

- Nessun endpoint di invio "effimero" senza persistenza — si riusa
  interamente l'infrastruttura Campaign/Recipient/NotificationAttempt/
  queue esistente, per garanzia di comportamento identico al lancio
  reale (motivazione esplicita: minimizzare rischio che test e invio
  reale si comportino diversamente).
- Nessun nuovo valore enum `CampaignStatus`.
- Nessuna modifica al meccanismo INAD (il test bypassa volutamente
  l'override INAD scegliendo un CF/destinazione di comodo).
