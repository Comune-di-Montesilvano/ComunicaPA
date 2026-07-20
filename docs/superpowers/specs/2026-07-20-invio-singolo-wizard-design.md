# Invio Singolo — riuso wizard campagne massive

## Problema

`view === 'invio-singolo'` (`App.tsx:5530-5673`) è un form autonomo,
scollegato dal wizard multi-step (`view === 'invio-massivo-wizard'`), che
finge un CSV a 1 riga sotto al cofano (`App.tsx:2236-2240`) e chiama
un percorso di lancio ridotto. Di conseguenza NON eredita nessuna delle
regole aggiunte al wizard nel tempo:

- validazione lunghezza oggetto/body App IO (`APP_IO_SUBJECT_MIN/MAX`,
  `wizAppIoBodyLenInvalid`)
- allegato obbligatorio per SEND e POSTAL (bloccante in UI+backend nel
  wizard, assente qui — SEND/POSTAL sono di fatto inutilizzabili da
  invio singolo)
- App IO co-consegna (parallela/esclusiva)
- step "Invia Test" prima del lancio reale
- anteprima ricca contenuto/allegati

Questo viola anche la regola "creazione campagne — un solo percorso"
già in CLAUDE.md, che oggi si applica solo a bulk/CSV, non a questo form.

## Soluzione

Non un form nuovo. Il wizard esistente (7 step, `wizStep` 1-7) prende un
flag `wizSingleMode: boolean`. In questa modalità gli step 2 ("Caricamento
File") e 3 ("Mappatura & Validazione") sono sostituiti da un unico step
"Destinatario" con form diretto; tutto il resto del wizard (step 1, 4, 5,
6, 7) resta identico, invariato, channel-agnostic com'è oggi.

### Entry point

Voce nav "Invio Singolo" resta separata (non confluisce in "Invio
Massivo"). Click:

```
resetWizard();
setWizSingleMode(true);
setView('invio-massivo-wizard');
```

`resetWizard()` deve azzerare `wizSingleMode` a `false` di default (stesso
pattern di ogni altro stato `wiz*` — vedi CLAUDE.md "terzo punto di sync,
oltre ai due sopra: il lifecycle del wizard stesso"). `prefillWizardFrom()`
deve ripristinare `wizSingleMode` dal `channelConfig` salvato se si
riprende una bozza creata in questa modalità (campo persistito in
`channelConfig.wizSingleMode`, stesso posto dove oggi vive `wizStep`).

### Step 1 — Dettagli & Canale

Invariato. Stesso form nome campagna + selezione canale.

### Step 2+3 fusi — "Destinatario" (solo in `wizSingleMode`)

Sostituisce dropzone CSV + tabella mappatura colonne con form diretto,
stessi campi del form attuale invio-singolo:

- Codice Fiscale/P.IVA destinatario (obbligatorio, validato con
  `isValidCfOrPiva`, stessa funzione già in uso)
- Nome completo (opzionale)
- Email (opzionale, obbligatoria se canale EMAIL/richiesta da co-consegna)
- PEC (opzionale, obbligatoria se canale PEC)

Al submit del form:

1. genera in memoria un CSV 1-riga con header fissi
   `codice_fiscale,full_name,email,pec` (stesso pattern già usato in
   `handleSingleSendSubmit` oggi, `App.tsx:2240`)
2. popola `wizCsvHeaders`/`wizCsvRows` con questo CSV
3. popola `wizMapping` con mapping fisso ai 4 header noti (nessuna UI di
   mappatura: 1 riga, colonne già note, niente da confermare)
4. valida la riga con la stessa logica di validazione riga-CSV esistente
   (`App.tsx` intorno a 4006-4111 — riuso, non reimplementazione)
5. avanza direttamente a step 4 (salta gli step 2/3 "veri")

Se il canale richiede allegato (SEND/POSTAL) o App IO è coinvolto, tutto
il resto del flusso (step 5 upload allegati, validazioni step 4/6) si
comporta esattamente come nel percorso CSV multi-riga — nessuna logica
duplicata.

### Step 4-7

Invariati. Anteprima/template, upload allegati, review+lancio, invia
test — stessi componenti, stesso codice, oggi già channel-agnostic.
Per una campagna a singolo destinatario il "preview index selector"
(usato oggi per scorrere righe CSV multiple) è irrilevante ma non va
rimosso: con 1 sola riga valida resta semplicemente fisso, nessun ramo
speciale da scrivere.

### Tab bar step progress

L'header con gli step cliccabili (`App.tsx` "Steps Progress Header")
mostra, in `wizSingleMode`, un'unica label "Destinatario" al posto di
"File CSV" + "Mappatura" per lo step fuso. Gating esistente
(`wizMaxReachedStep`, snapshot `wizLastSyncedHeaders`/`wizLastSyncedMapping`)
si applica invariato — lo step fuso conta come uno step valido ai fini
del gating (si comporta come se 2→3 fosse stato completato atomicamente).

### Sync bozza/Recipient

`syncWizDraftAndRecipients(targetStep)` (vedi CLAUDE.md, gotcha "wizard
campagne — sync bozza/Recipient anticipato ad ogni avanti") si applica
invariato: ogni "avanti" da questo step in poi sincronizza bozza+Recipient
in DB esattamente come nel percorso CSV normale, perché a valle dello step
fuso lo stato interno (`wizCsvRows`/`wizMapping`) è indistinguibile da un
CSV caricato normalmente.

## Cosa NON cambia

- Il form vecchio (`handleSingleSendSubmit`, righe 2194-2240+ e il blocco
  JSX 5530-5673) viene rimosso — non resta come fallback, per non avere
  due percorsi di invio singolo in parallelo.
- Nessun nuovo endpoint backend. Il lancio usa lo stesso
  `CampaignsService.launch()` di ogni altra campagna wizard.
- Nessuna modifica alle regole matrice canale/INAD/App IO/allegato (già
  documentate in `2026-07-17-matrice-comportamenti-campagne-design.md`) —
  questo spec le eredita, non le tocca.

## Fuori scope (rimandato a sub-progetti successivi)

Riorganizzazione nav in sezione "Utility" (Ricerca Notifiche, Verifica
App IO, Statistiche, Arricchimento Tracciati) e restyling visivo generale
dell'admin: sub-progetti separati, spec propri, non toccati da questo
lavoro.
