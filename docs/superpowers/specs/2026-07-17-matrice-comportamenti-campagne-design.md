# Matrice comportamenti campagne

Data: 2026-07-17
Stato: documentazione di riferimento (non normativa per il codice — audit di allineamento è lavoro futuro separato)

## Scopo

Fissare in un solo posto tutte le combinazioni di comportamento possibili per
una campagna, in funzione di canale primario + assi indipendenti (App IO
secondaria, dirottamento INAD, protocollazione, pagamento, allegato). Verificato
contro il codice reale (`campaigns.service.ts`, `notification.processor.ts`),
non solo contro il manuale/design doc.

## Assi indipendenti

### 1. Canale primario
EMAIL · PEC · APP_IO · SEND · POSTAL

### 2. App IO secondaria
Applicabile solo se canale primario ∈ {EMAIL, PEC, POSTAL} — `isMailChannel`
in `notification.processor.ts:147`. Mai per APP_IO primario (ridondante), mai
per SEND (escluso da `isMailChannel`, pipeline propria).

Valori: `none` / `parallela` / `esclusiva`.

Regola di declassamento: se `esclusiva` E il destinatario è dirottato da INAD
(`recipient.inadCheck.diverted === true`) → declassata a `parallela` SOLO per
quel destinatario (`notification.processor.ts:167`). INAD è fonte di verità
assoluta sul domicilio digitale, non bypassabile da un'esclusiva App IO.

### 3. Dirottamento INAD
Check gira su TUTTI i canali tranne SEND (`campaigns.service.ts:366`:
`inadCheckEnabled = campaign.channelType !== 'SEND' && settings.inad.checkEnabled`).
SEND escluso perché PN risolve da sé il domicilio digitale (ANPR/INAD interno).

`diverted = found && inadAddress !== recipient.pec` (`campaigns.service.ts:404,520`)
— confronto sempre contro `recipient.pec` esistente, indipendente dal canale
campagna.

Effetto per canale primario:
- **EMAIL / POSTAL / APP_IO**: se `diverted` → `NotificationAttempt.channelType`
  dirottato a PEC (skip invio via canale originale), `recipient.pec` valorizzato
  con l'indirizzo INAD trovato.
- **PEC**: se `diverted` → NON channelType override (già PEC), ma
  `recipient.pec` viene comunque sovrascritto con l'indirizzo INAD trovato
  (riga 415/531) — cambia indirizzo di invio, resta stesso canale. Non è un
  no-op: la PEC configurata era stale/sbagliata.
- **SEND**: n/a, check non gira.

`found` (INAD ha trovato un domicilio) ≠ `diverted` (l'indirizzo trovato è
REALMENTE diverso da quello già su `recipient.pec`). Reporting/instradamento
sempre su `diverted`.

### 4. Protocollazione
Opzionale per tutti i canali tranne SEND (sempre attiva lì — motore
PROTOCOLLAZIONE gira dopo l'accettazione PN, non modifica il comportamento
del flusso di invio in sé). Motore channel-agnostic (`EngineName`, non
`NotificationChannel`), usato solo da SEND oggi ma non specifico a SEND.

### 5. Pagamento
Opzionale per tutti i canali, nessun impatto su comportamento invio/canale.

### 6. Allegato
- **SEND, POSTAL**: obbligatorio — è il contenuto stesso della notifica
  (atto legale / lettera cartacea), non un corredo al body. Bloccato sia UI
  wizard che backend (`launch()`).
- **EMAIL, PEC, APP_IO**: opzionale, corredo al body. Se configurato, il
  template deve poterlo referenziare: `%%elenco_allegati%%` OPPURE tutti gli
  `%%allegatoN%%` corrispondenti (un sottoinsieme di singoli non basta),
  altrimenti `launch()` blocca — nessun modo per il destinatario di
  scaricarlo altrimenti. Stessa regola per il corpo App IO differenziato di
  co-consegna (`secondaryChannels`/`appIo.bodyOverride`), indipendentemente
  dal canale primario. Bloccato sia UI wizard (step4) che backend
  (`checkAttachmentsBlocking`). POSTAL/SEND esclusi da questa regola: per
  loro il corpo non è mai il contenuto reale (POSTAL) o l'allegato è già
  l'unico contenuto (SEND). Vedi
  `docs/superpowers/specs/2026-07-23-blocco-allegati-senza-placeholder-design.md`.

## Matrice per canale primario

| Canale | App IO secondaria | Dirottamento INAD | Protocollo | Allegato |
|---|---|---|---|---|
| EMAIL | none / parallela / esclusiva (→parallela se destinatario dirottato) | sì, → `channelType` PEC + `recipient.pec` = indirizzo INAD | opzionale | opzionale |
| PEC | none / parallela / esclusiva (→parallela se destinatario dirottato) | sì, se PEC INAD diversa da quella configurata → solo `recipient.pec` sovrascritto (canale resta PEC, nessun override) | opzionale | opzionale |
| POSTAL | none / parallela / esclusiva (→parallela se destinatario dirottato) | sì, → `channelType` PEC (skip stampa/spedizione cartacea) + `recipient.pec` = indirizzo INAD | opzionale | **obbligatorio** |
| APP_IO | n/a (canale già App IO) | sì, → `channelType` PEC (skip invio App IO) + `recipient.pec` = indirizzo INAD | opzionale | opzionale |
| SEND | n/a (escluso da `isMailChannel`) | n/a (PN gestisce domicilio digitale via ANPR/INAD proprio) | **obbligatorio** | **obbligatorio** |

## Non incluso / fuori scope

- **Verifica toponomastica/residenza**: non implementata. Quando esisterà,
  impatterà solo POSTAL (oggi POSTAL si aspetta indirizzo corretto in input,
  ritenta su indirizzo alternativo solo se il tentativo di spedizione fallisce
  lato provider — nessuna verifica preventiva).
- Combinazioni di canale secondario diverse da App IO (non esistono altri
  canali secondari nel sistema oggi).

## Note per uso futuro

Questo file descrive lo stato del codice al 2026-07-17. Se emergono nuove
combinazioni (nuovo canale, nuovo asse) o il comportamento cambia, aggiornare
qui prima/insieme alla modifica di codice — è la fonte di verità per capire
"cosa succede se combino X con Y" senza dover rileggere 5 file diversi.
