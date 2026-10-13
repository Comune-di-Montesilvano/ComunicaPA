# Notifiche senza esito legale — design

_2026-10-13_

## Obiettivo

In dashboard l'operatore vede, raggruppate per campagna, le notifiche a valore
legale che non porteranno mai a una data legale di notifica (esito bloccante)
o che sono ferme da troppo tempo senza esito. Per ciascuna può dare **presa
visione** o, se è solo ferma, **posticiparne** la segnalazione.

## Perimetro

- **Campagne**: `channelType = 'SEND'`, oppure `'POSTAL'` con
  `hasPostalArTracking(campaign)` (Agol, o Raccomandata con AR). Escluse
  `isTest = true`. PEC esclusa: non ne tracciamo l'esito.
- **Unità**: il destinatario (`recipients`), valutato sul suo ultimo tentativo
  (`notification_attempts`, `attempt_number` più alto).
- **Visibilità**: operatore (`role = 'user'`) solo campagne con
  `createdBy = username`; amministratore tutte. Stesso criterio di
  `assertOwnership`.

## Classificazione

Funzione pura `legalAttentionOf()` e gemella SQL in
`legal-attention/legal-attention.util.ts`, stesso pattern di
`postal-legal-outcome.util.ts` (regole scritte una volta, test di parità
TS/SQL). Risultato: `'blocking' | 'stale' | null` più `reason`.

| Classe | Posta con AR | SEND |
|---|---|---|
| `blocking` | `postalLegalOutcome` = `not_delivered` (deceduto, irreperibile, sconosciuto, trasferito, indirizzo errato/insufficiente/sconosciuto, smarrito, inesitato, errore GlobalCom, invio fallito); `reason` = motivo dell'esito | `sendStatus` ∈ `REFUSED`, `CANCELLED`, `RETURNED_TO_SENDER`, oppure ultimo tentativo `status = 'failed'`; `reason` = stato PN o `errorMessage` |
| `stale` | esito `in_progress` o `unclassified` **e** primo tentativo creato da più di 45 giorni | `sendLegalDateOf(sendStatusHistory)` nullo, non `blocking`, **e** primo tentativo creato da più di 45 giorni; `reason` = ultimo stato PN + giorni trascorsi |
| `null` | `delivered`, `no_legal_value`, dirottato INAD con esito | data legale presente (VIEWED o EFFECTIVE_DATE: include `UNREACHABLE`, che si perfeziona comunque) |

- `blocking` si valuta per primo e non ha soglia temporale.
- I 45 giorni partono da `created_at` del **primo** tentativo del
  destinatario (non dalla campagna: una bozza ferma non falsa il conteggio).
  Costante `STALE_AFTER_DAYS = 45`.
- Destinatario senza alcun tentativo: non segnalato (non ancora inviato).

## Modello dati

Nuova entity `NotificationReview`, tabella `notification_reviews`, con
migration. Storico append-only: una riga per azione, mai update.

| Colonna | Tipo | Note |
|---|---|---|
| `id` | uuid PK | |
| `recipient_id` | uuid FK → recipients, `ON DELETE CASCADE` | indice `(recipient_id, kind, created_at DESC)` |
| `campaign_id` | uuid | indice; denormalizzato per query per campagna |
| `kind` | varchar(10) | `blocking` / `stale`: classe al momento dell'azione |
| `action` | varchar(10) | `ack` / `snooze` |
| `snoozed_until` | timestamptz null | solo per `snooze` |
| `reason` | text | motivo segnalato al momento dell'azione |
| `note` | text null | facoltativa, max 1000 caratteri |
| `created_by` | varchar(255) | username |
| `created_at` | timestamptz | default now() |

`ON DELETE CASCADE`: la retention che cancella i destinatari porta via anche
le review, coerente con il resto dei dati per-destinatario.

**Segnalata** = classe corrente ∈ {`blocking`, `stale`} **e** l'ultima riga
con lo stesso `kind` non è `ack` né `snooze` con `snoozed_until > now()`.

Conseguenze:
- `ack` su `stale` non copre un successivo `blocking`: la notifica torna in
  evidenza.
- A scadenza del posticipo ricompare da sola se ancora `stale`; se nel
  frattempo ha data legale esce comunque.
- `snooze` ammesso solo per `stale`.

## API

Modulo `apps/backend/src/legal-attention/` (util, entity, service,
controller, module). Route operatore sotto `admin/`, guard JWT operatore.

1. `GET admin/legal-attention` → `{ items: [{ campaignId, name, channelType,
   createdBy, createdByDisplayName, blockingCount, staleCount }] }`, solo
   campagne con almeno una segnalata, ordinate per `blockingCount` desc poi
   `staleCount` desc. `createdByDisplayName` da `OperatorDirectoryService`.
2. `GET admin/legal-attention/campaigns/:id?page=&pageSize=` → `{ items:
   [{ recipientId, fullName, codiceFiscale, kind, reason, firstAttemptAt,
   iun, postalCode, lastReview }], total }`. `postalCode` = codice
   raccomandata GlobalCom; `lastReview` = ultima azione registrata (anche non
   più attiva, es. snooze scaduto) o null. 404 se campagna fuori perimetro,
   403 se non di proprietà.
3. `POST admin/legal-attention/reviews` body `{ recipientIds: string[]
   (1..500), action: 'ack' | 'snooze', snoozedUntil?: ISO date, note?:
   string }` → `{ applied: number, skipped: [{ recipientId, reason }] }`.
   - Classe ricalcolata lato server, mai presa dal client.
   - Scartati con motivo: destinatario inesistente, non più segnalato,
     `snooze` su `blocking`.
   - 400 se `snooze` senza `snoozedUntil`, o con data non futura o oltre
     un anno.
   - 403 se una qualunque campagna coinvolta non è dell'operatore (admin
     bypassa).
   - Insert in una transazione; una voce audit log per richiesta (azione,
     campagna/e, numero destinatari, nota) via `AuditLogsService.log()`.

## Prestazioni

La query di riepilogo parte dalle campagne in perimetro, per ogni
destinatario prende l'ultimo tentativo con `LEFT JOIN LATERAL` (indice
migration `notification_attempts(recipient_id…)`) e l'ultima review per
`kind`. Chiamata solo all'apertura dashboard e dal pulsante "Aggiorna", mai
nel polling a 5s. Benchmark in dev su volumi realistici (es. 20 campagne ×
20.000 destinatari) dentro `BEGIN … ROLLBACK`, creando gli indici che in dev
mancano (DB dev in `synchronize`). Se oltre ~2s su volumi reali: valutare
una tabella materializzata aggiornata da cron (approccio scartato per ora).

## Interfaccia (frontend-admin)

Componenti in `src/components/legal-attention/`, non in `App.tsx`.

- **Riquadro dashboard "Notifiche senza esito legale"**, in alto, solo se
  ci sono segnalazioni. Riga per campagna: nome, logo canale, "Creata da"
  (solo admin), badge rosso "N esito bloccante", badge giallo "N ferme da
  almeno 45 giorni". Pulsante **Aggiorna**.
- **Pannello laterale** al clic sulla riga: tabella paginata con checkbox,
  destinatario, CF, classe, motivo, IUN/codice raccomandata. Clic sul
  destinatario apre il dettaglio notifica esistente. Barra azioni sulla
  selezione:
  - **Presa visione** con nota facoltativa;
  - **Posticipa**: 15 / 30 / 45 giorni / altra data (date picker), nota
    facoltativa. Disabilitato se la selezione contiene `blocking`, tooltip
    con il motivo.
  - Dopo l'azione: righe rimosse, messaggio con applicati/scartati e motivi.
  - Link "Apri campagna".

## Guida operatori

Nella stessa PR, data in testa aggiornata:
- Operazioni frequenti → "Gestire le notifiche senza esito legale": cosa
  si segnala e perché, presa visione, posticipo.
- Problemi frequenti → "Una notifica SEND irreperibile non compare tra le
  segnalazioni" (Causa: SEND la perfeziona comunque; Soluzione: nessuna).
- Nuova chiave `dashboard` in `GUIDA_PER_VISTA` (`src/guida.ts`, oggi assente) verso la nuova sezione.

## Test

- `legal-attention.util.spec.ts`: tabella casi (ogni riga della tabella di
  classificazione, soglia 45 giorni ai bordi, nessun tentativo, dirottato
  INAD, SEND UNREACHABLE perfezionata).
- Parità TS/SQL su fixture in DB, stesso schema di
  `campaigns.service.legal-outcome.spec.ts`.
- Service: visibilità operatore/admin, review con ricalcolo classe,
  scarti, `snooze` su `blocking` rifiutato, limiti `snoozedUntil`, ack che
  non copre un cambio di classe, snooze scaduto che ricompare.
- Controller: deleghe e codici HTTP.

## Fuori perimetro

- Rinvio della notifica (nuovo tentativo) dalle segnalazioni.
- PEC, Email, App IO, Posta senza AR.
- Notifiche push/email all'operatore: solo dashboard.
- Annullare una presa visione da UI (lo storico resta; eventuale valvola
  in futuro).
