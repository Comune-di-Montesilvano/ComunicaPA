# Regole subject/body per canale (wizard singolo)

Data: 2026-08-11
Stato: documentazione di riferimento (non normativa per il codice — audit di allineamento è lavoro futuro separato)

## Scopo

Fissare in un solo posto obbligatorietà e vincoli di `subject`/`body` per
ciascun canale primario, in modalità **wizard singolo** (`channelConfig.wizSingleMode
=== true`) — il percorso a cui mappa sia l'invio singolo da wizard admin sia
ogni chiamata dell'[API esterna caricamento puntuale](2026-08-10-external-api-caricamento-puntuale-design.md).
Verificato contro il codice reale (`App.tsx`, `create-external-notification.dto.ts`),
non contro un riassunto del comportamento atteso.

**Fuori scope**: modalità bulk-CSV, dove `subject`/`body` possono venire
sovrascritti per singolo destinatario da `csvMapping.subject`
(`subject-mapping.util.ts`) — regole diverse, non coperte qui.

## Il gate giusto — attenzione, non ovvio

In `wizSingleMode`, lo step "Template" del wizard (dove vive il gate più
visibile, il bottone "Riepilogo" a `App.tsx` righe ~10455-10469/10672-10686)
viene **saltato del tutto per SEND e POSTAL**:

```js
wizSingleNeedsTemplateStep = channelType==='EMAIL' || channelType==='PEC' || channelType==='APP_IO'
// App.tsx:1855 — SEND e POSTAL esclusi
```

Il gate realmente eseguito per SEND/POSTAL in modalità singola è quello dei
bottoni finali "Avvia Test"/"Conferma ed Avvia Campagna" allo step conclusivo
(`App.tsx:11021`/`:11029`, duplicato `:11172`/`:11180`):

```js
disabled = wizSending || (wizSingleMode && !wizSingleNeedsTemplateStep && !wizSubject.trim())
```

Per SEND/POSTAL questo si riduce a `!wizSubject.trim()` **incondizionato**,
senza legame con altre opzioni del canale (es. `secondaryAppIo`). Un'
implementazione basata sul gate step4 (mai raggiunto per questi due canali)
ha prodotto un bug reale: `subject` reso erroneamente opzionale per POSTAL.
Qualunque futura modifica alle regole di contenuto per SEND/POSTAL deve
partire da QUESTO gate.

## Emptiness ≠ solo lunghezza zero

Il wizard misura "campo vuoto" con `isWizBodyEmpty()`/`.trim()` **dopo** aver
stripato l'HTML (`body` è editor rich-text) — non con `value.length === 0`
grezzo. Un check che non fa lo strip prima di contare accetta come validi
`subject: "   "` (solo spazi) o `body: "<p></p>"` (paragrafo HTML vuoto), che
il wizard rifiuterebbe. La stessa funzione di strip va riusata sia per
l'emptiness check sia per i vincoli di lunghezza sotto — bug reale corretto:
le due cose erano state implementate con criteri diversi in un primo
tentativo.

## Tabella per canale

| Canale | `subject` | `body` | `secondaryAppIo` (co-consegna App IO) |
|---|---|---|---|
| EMAIL | obbligatorio, non vuoto (trim) | obbligatorio, non vuoto (HTML-stripped) | opzionale; se assente override, il fallback su subject/body principali deve comunque rispettare [10,120]/[80,10000] (vincolo PagoPA — `body` misurato su testo HTML-stripped) |
| PEC | obbligatorio, non vuoto (trim) | obbligatorio, non vuoto (HTML-stripped) | idem EMAIL |
| APP_IO | obbligatorio, [10,120] caratteri (HTML n/a, campo plain-text) | obbligatorio, [80,10000] caratteri su testo HTML-stripped | **rifiutato** — selettore mai renderizzato nel wizard per canale primario App IO |
| SEND | obbligatorio, non vuoto (gate step finale single-mode) | **rifiutato se valorizzato** — campo mai renderizzato per SEND | **rifiutato** — n/a nel wizard |
| POSTAL | **obbligatorio sempre**, non vuoto (gate step finale single-mode, incondizionato — non legato a `secondaryAppIo`) | **rifiutato se valorizzato** — POSTAL non ha mai contenuto testuale reale (l'invio è l'allegato) | opzionale; se presente, `subjectOverride`+`bodyOverride` **entrambi obbligatori** — non per parità wizard-gate stretta, ma perché senza override il fallback ricadrebbe su `channelConfig.body` (sempre assente per POSTAL) → stringa vuota → PagoPA rifiuta con HTTP 400 al momento dell'invio reale |

Vincoli di lunghezza App IO ([10,120] subject / [80,10000] body) si applicano
sempre a `wizAppIoInvolved = channelType==='APP_IO' || secondaryAppIo presente`
— quindi anche a EMAIL/PEC con co-consegna App IO attiva, non solo al canale
primario App IO.

## Non incluso / fuori scope

- Modalità bulk-CSV (vedi sopra).
- Vincoli di formato oltre lunghezza/emptiness (es. contenuto HTML valido,
  placeholder `%%chiave%%` risolvibili — vedi `template.helper.ts` e la
  matrice comportamenti campagne per la regola allegati/placeholder).

## Note per uso futuro

Questo file descrive lo stato del codice al 2026-08-11. Se cambia il gate
wizard per un canale, o si aggiunge un nuovo canale/asse di contenuto,
aggiornare qui prima/insieme alla modifica di codice.
