# Motori — pannelli non-BullMQ coerenti (SEND, INAD, POSTAL status-sync) — design

Data: 2026-08-12

## Contesto

La tab "Motori" (`GET /admin/engines`) mostra stato in tempo reale delle code
BullMQ (EMAIL/PEC/APP_IO/POSTAL/PROTOCOLLAZIONE) con pausa/riprendi/job
falliti/log — pattern uniforme, funzionante.

Due canali non passano da BullMQ (SEND e INAD, entrambi demoni `@Cron`
poll-based, refactor documentato in `notification-job.types.ts:6-9`) ma
`EnginesController.list()` li inserisce comunque nello stesso array
`engines`, con conteggi fabbricati da `NotificationAttempt`/`Recipient` per
imitare la forma di un job BullMQ (`waiting`/`active`/`completed`/`failed`).
Il frontend renderizza ogni elemento dell'array con lo stesso componente
generico — inclusi i bottoni Pausa/Riprendi, che per SEND/INAD chiamano
`pause('SEND')`/`pause('INAD')`: `isEngineName()` verifica contro
`ENGINE_NAMES` (solo EMAIL/PEC/APP_IO/POSTAL/PROTOCOLLAZIONE), quindi il
bottone risponde sempre 400 "Motore non supportato" — bug reale, bottone
morto mostrato come funzionante.

Per SEND esiste già un secondo pannello, corretto e specifico
(`GET /admin/engines/send/stage-counts`, card "Protocollato/Inviato/Fallito"
renderizzata subito dopo il loop `engines.map()`) — la card fasulla
generata dall'array `engines` è quindi anche ridondante, non solo rotta:
stessa informazione (canale SEND) mostrata due volte con numeri diversi
(la fasulla legge stati generici dell'attempt, la corretta legge le fasi
protocollazione→invio→esito del demone reale) — fonte della domanda
"perché ci sono due SEND?".

Nessun pannello analogo esiste per `PostalStatusSyncService` — il demone
Cron (ogni 1 minuto, batch 200) che interroga GlobalCom per lo stato di
consegna delle raccomandate già inviate (diverso dalla coda "Postalizzazione"
esistente, che è l'invio vero e proprio via BullMQ). Questo demone ha una
storia documentata di bug da starvation (`docs`/CLAUDE.md: ORDER BY statico,
IDPRO che falliscono sempre, record `Eliminato` esclusi dal filtro) — serve
un modo per l'operatore di vedere se sta "girando bene" senza aspettare che
il sintomo (costo/stato fermi da giorni) diventi visibile solo indirettamente
su una singola notifica.

## Fix 1 — rimuovere la card SEND fasulla

`EnginesController.list()`: eliminare il blocco che fabbrica un'entry
`{channel:'SEND', queueName:'notifications-send', ...}` (righe 62-74).
Nessuna perdita di informazione: la card `sendStageCounts` già esistente
copre lo stesso canale con dati corretti (fasi reali del demone, non stati
generici dell'attempt travestiti da coda).

## Fix 2 — INAD non pausabile

L'entry INAD (righe 82-94) resta nell'array `engines` (nessun pannello
alternativo esiste per lei, a differenza di SEND) ma guadagna un campo
`pausable: false`. Il tipo di ritorno di `list()` include `pausable: boolean`
su ogni entry (`true` per le code BullMQ reali EMAIL/PEC/APP_IO/POSTAL/
PROTOCOLLAZIONE, `false` per INAD).

Frontend (`App.tsx`, blocco `engines.map()`): quando `eng.pausable === false`,
non renderizzare i bottoni Pausa/Riprendi (badge di stato Idle/Attivo resta,
solo informativo) né "Vedi job falliti" (non ha senso per un demone senza
concetto di "job BullMQ fallito" — INAD non ha una nozione di job fallito
separata dai suoi contatori `foundCount`/conteggi già mostrati).

## Fix 3 — pannello "Verifica Stato POSTAL" (nuovo)

**Backend** — `PostalStatusSyncService`: il query-builder che seleziona i
candidati dentro `handleCron()` (righe 39-76 di
`postal-status-sync.service.ts`) viene estratto in un metodo privato
riusabile `getCandidatesQuery()` — stesso WHERE, un solo punto di verità
(chi in futuro cambia il filtro del cron lo cambia una volta sola, niente
drift tra la query reale e quella del pannello di stato).

Nuovo metodo pubblico `getQueueHealth()`:
```ts
interface PostalQueueHealth {
  candidatesCount: number;          // quanti record il prossimo giro cron ripescherà
  oldestCandidateAgeMinutes: number | null; // età (minuti) del candidato più "anziano" mai ricontrollato — null se coda vuota
  verifiedCount: number;            // POSTAL SUCCESS con tracking id, NON candidati (già a posto)
  errorCount: number;               // postal_status = 'Errore' (informativo)
}
```
`oldestCandidateAgeMinutes` = `now - MIN(COALESCE(postal_last_checked_at, created_at))`
tra i candidati di `getCandidatesQuery()` — stessa colonna già usata per
l'`ORDER BY` anti-starvation del cron, nessuna colonna nuova.

Nuovo endpoint `GET /admin/engines/postal/queue-health` su
`EnginesController`, stesso pattern REST di `send/stage-counts`.

**Frontend** — nuova card, stesso stile visivo della card SEND stage-counts,
posizionata subito dopo la card "Postalizzazione" esistente (distinzione
esplicita: quella è l'invio/coda BullMQ, questa è la verifica-stato/demone —
stessa distinzione già fatta per SEND, stesso principio "due pannelli per
due responsabilità diverse" invece di forzarle nello stesso componente).
Mostra i 4 numeri (`In coda`, `Più vecchio in attesa da: Xh Ym`, `Verificato`,
`Errore`). Bordo/badge di warning quando `oldestCandidateAgeMinutes > 15`
(soglia scelta: con `BATCH_SIZE=200` e cron ogni 1 minuto, anche con
migliaia di candidati un giro round-robin completo richiede minuti — oltre
15 minuti senza mai essere ripescato è già anomalo, coerente con gli
scenari di starvation-per-giorni già documentati come bug reali).

## Testing

- `PostalStatusSyncService.getQueueHealth()`: unit test con repo mockato
  (stesso pattern degli altri test del file) — verifica candidatesCount,
  oldestCandidateAgeMinutes su fixture con timestamp noti, verifiedCount,
  errorCount. Caso coda vuota → `oldestCandidateAgeMinutes: null`.
- `EnginesController`: test esistenti aggiornati per il campo `pausable`
  su ogni entry e per l'assenza dell'entry SEND fasulla; nuovo test per
  `GET postal/queue-health`.
- Nessun test E2E frontend richiesto (component render condizionale,
  pattern già coperto da test manuali sulle card esistenti).

## Fuori scope

- Soglia di warning (15 min) non configurabile da UI — hardcoded, coerente
  con `BATCH_SIZE`/cron interval già hardcoded nello stesso file.
- Nessun alert/notifica proattiva (email, badge globale) se la coda POSTAL
  è in starvation — solo visibilità passiva sulla tab Motori, come tutto il
  resto della pagina.
- Non si tocca la logica di selezione/starvation del cron stesso (già
  corretta, round-robin su `postal_last_checked_at` già in produzione) —
  solo esposizione in lettura del suo stato.
