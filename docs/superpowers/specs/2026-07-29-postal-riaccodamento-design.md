# Gestione riaccodamento GlobalCom (POSTAL) — design

Data: 2026-07-29

## Problema

GlobalCom può riaccodare autonomamente un documento (es. errore tecnico lato
loro sui server Poste) generando un nuovo IDPRO che sostituisce quello
originale. Lato nostro, l'attempt originale resta bloccato per sempre a
`postalStatus = 'Eliminato'` (stato terminale, mai più ripollato) — nessuna
visibilità sul nuovo IDPRO realmente attivo, nessun modo di seguirne lo stato
di consegna reale.

Manuale tecnico GlobalCom documenta due metodi dedicati:
- `lista_riaccodamenti_documento(IDPRO)` — intera catena di IDPRO coinvolti
  nel riaccodamento, ordinata; l'ultimo è quello corretto/attivo. Se non ci
  sono riaccodamenti, ritorna solo l'IDPRO iniziale.
- `StatoInvio` con `UltimoRiaccodamento=true` — non necessario in questo
  design: una volta noto l'ultimo IDPRO dalla lista sopra, riusiamo il
  metodo di poll già esistente (`dettagliDocumento`, già collaudato in
  `PostalStatusSyncService`) per leggerne lo stato pieno (incluso costo).

**Mai riaccodare a mano.** Confermato da supporto GlobalCom: un documento in
errore va lasciato a loro, che lo riaccodano se necessario — nessuna azione
di reinvio manuale va presa lato nostro su un IDPRO Eliminato.

## Modello dati

Riuso del pattern già esistente in tutto il codebase per "ultimo tentativo
di un destinatario" = `NotificationAttempt` con `attemptNumber` più alto per
quel `recipientId` (stesso principio di `retryRecipient()`, breakdown
SEND/POSTAL, override INAD — vedi CLAUDE.md). Un riaccodamento trovato crea
un **nuovo `NotificationAttempt`** (non un update in-place dell'attempt
Eliminato):

- `recipientId` = stesso destinatario
- `channelType` = `'POSTAL'`
- `status` = `AttemptStatus.SUCCESS` (il nuovo IDPRO è già accettato da
  GlobalCom — non è un nostro re-invio, solo la scoperta di un invio già
  avvenuto sotto un ID diverso)
- `attemptNumber` = max esistente per il destinatario + 1
- `postalTrackingId` = ultimo IDPRO della catena
- `postalStatus`/`postalStatusUpdatedAt`/`postalStatusHistory` = stato letto
  da `dettagliDocumento` sul nuovo IDPRO
- `costCents`/`costBreakdown` = dallo stesso `dettagliDocumento`, se presente
- `sentAt` = timestamp di rilevazione (non abbiamo la vera data di
  riaccodamento lato GlobalCom in modo affidabile senza un'altra chiamata)

L'attempt originale (Eliminato) resta intatto come storico — nessuna
modifica ai suoi campi oltre al flag di controllo sotto. Nessun campo di
collegamento esplicito (`supersededByAttemptId`): il nuovo attempt si
aggancia automaticamente a tutta la UI/query esistenti che già scelgono
"l'ultimo per attemptNumber" (tabella Storico Tentativi nel dettaglio
notifica, breakdown, export CSV...) — zero modifiche frontend richieste.

**Nuova colonna** `notification_attempts.postal_requeue_checked_at`
(timestamptz, nullable) — traccia se il controllo riaccodamento è già stato
fatto per un attempt Eliminato, per distinguere automatico (una tantum) da
manuale (sempre).

## Trigger

`PostalStatusSyncService.syncOne()` esteso con parametro `forceRequeueCheck:
boolean = false`. Dopo l'aggiornamento normale di `postalStatus`, se il
risultato è `'Eliminato'`:

- **Cron (`handleCron`, automatico)** — `forceRequeueCheck=false`: esegue il
  controllo riaccodamento **solo se** `postal_requeue_checked_at IS NULL`.
  Al termine del controllo (indipendentemente dall'esito: trovato o non
  trovato) stampa `postal_requeue_checked_at = now()` — mai ripetuto in
  automatico sullo stesso attempt.
- **Manuale (`refreshOne`, bottone "Ricontrolla stato GlobalCom" esistente
  nel dettaglio notifica)** — `forceRequeueCheck=true`: esegue il controllo
  **sempre**, ignora il flag già impostato (ma lo aggiorna comunque a
  `now()`, innocuo). Nessun nuovo bottone in UI.

Se la chiamata SOAP di `lista_riaccodamenti_documento` fallisce (errore di
rete/sessione), il flag **non** viene stampato — il prossimo giro cron
riprova, stesso pattern try/catch già in uso in `handleCron`.

## Logica `checkRequeue`

1. `chain = await globalCom.listaRiaccodamentiDocumento(creds, attempt.postalTrackingId)`
2. Se `chain.length <= 1` o `chain[chain.length-1] === attempt.postalTrackingId`
   → nessun riaccodamento reale, solo stampa il flag, esce.
3. `nuovoIdPro = chain[chain.length - 1]` (ultimo = corretto, per manuale).
4. Guardia idempotenza: se esiste già un `NotificationAttempt` per lo stesso
   `recipientId` con `postalTrackingId === nuovoIdPro`, non ricrearlo (evita
   duplicati su corse doppie cron+manuale) — stampa comunque il flag.
5. `stato = await globalCom.dettagliDocumento(creds, nuovoIdPro)` (metodo
   già esistente, riusato as-is).
6. Crea il nuovo `NotificationAttempt` come descritto sopra.
7. Log (livello info): vecchio IDPRO → nuovo IDPRO, per audit/debug.

Catena con più di un riaccodamento (es. A→B→C): si crea **un solo** nuovo
attempt per l'ultimo IDPRO (C), non uno per ogni step intermedio — gli
intermedi sono solo storia interna GlobalCom, nessun valore nel duplicarli
come attempt separati.

## `GlobalComClient` — nuovo metodo

```ts
async listaRiaccodamentiDocumento(creds: GbcCredentials, idPro: string): Promise<string[]>
```

Chiama `lista_riaccodamenti_documentoAsync({ IDPRO: idPro })` (manuale
§2.2.57). Risposta probabile wrapper `ArrayOfString` (stesso gotcha WSDL già
noto per `Destinatari`/`Files`/`ProdottiDisponibili` — elemento ripetuto
nominato per tipo, non per campo): parsing difensivo con log del payload
grezzo se il risultato è vuoto/inatteso, stesso pattern già in uso in
`cercaPerTesto`. **Verificare la forma esatta della risposta con una
chiamata reale prima di fissare il parsing** (nessun WSDL/esempio a
disposizione ora, solo testo del manuale) — non fidarsi di un riassunto,
stesso principio già in CLAUDE.md per questa integrazione.

## Migration

Nuova colonna `notification_attempts.postal_requeue_checked_at` (timestamptz,
nullable) — generata con `typeorm migration:generate` su DB temporaneo
(procedura standard già in CLAUDE.md).

## Fuori scope

- Nessuna UI nuova: il nuovo attempt appare da solo nello storico tentativi
  esistente.
- Nessuna gestione di `StatoInvio`/`UltimoRiaccodamento` — ridondante con
  `lista_riaccodamenti_documento` + `dettagliDocumento` già disponibili.
- Nessun reinvio/retry automatico innescato da un riaccodamento: è solo
  presa d'atto di un invio già accettato da GlobalCom sotto nuovo IDPRO.
