# Download ricevute/documenti SEND (legal facts PN)

## Contesto

Il canale SEND (PN - Piattaforma Notifiche) sincronizza già `sendStatus`
(`send-status-sync.service.ts`) ma non espone i documenti opponibili a terzi
generati da PN durante il processo di notifica (presa in carico, consegna
digitale/cartacea, ricevuta PEC, mancata consegna, annullamento). L'operatore
PA deve poterli visualizzare e scaricare dal dettaglio destinatario di una
campagna, per usarli come prova legale in caso di contenzioso.

Verificato contro lo spec OpenAPI raw di PN (`pagopa/pn-delivery`,
`docs/openapi/api-external-b2b-pa-bundle.yaml`, non un riassunto): esiste
un'API dedicata `LegalFacts`, distinta dagli allegati caricati dal mittente
(`/delivery/notifications/sent/{iun}/attachments/documents/{docIdx}`, già
gestiti da questo repo per l'upload, non per la ricezione di ricevute).

## Scope

- Solo canale SEND (PEC/Email/Postal fuori scope — hanno meccanismi propri
  già gestiti altrove o non hanno un equivalente "legal fact" scaricabile).
- Solo documenti già generati e resi disponibili da PN via API. Nessuna
  generazione locale di PDF/ricevute.

## API PN utilizzate

Stesso `baseUrl`/auth (`x-api-key` + `Authorization: Bearer <voucher PDND>`)
già usato da `send-status-sync.service.ts` e `send-dispatch.service.ts` — il
gateway instrada sia `/delivery/*` che `/delivery-push/*` sullo stesso host.

- `GET {baseUrl}/delivery-push/v2.0/{iun}/legal-facts` — elenco documenti
  disponibili per la notifica. Risposta: array di
  `{ taxId?, iun, legalFactsId: { key, category } }`. `category` è uno tra:
  `SENDER_ACK`, `DIGITAL_DELIVERY`, `ANALOG_DELIVERY`, `RECIPIENT_ACCESS`,
  `PEC_RECEIPT`, `ANALOG_FAILURE_DELIVERY`, `NOTIFICATION_CANCELLED`.
- `GET {baseUrl}/delivery-push/{iun}/download/legal-facts/{legalFactId}` —
  metadati/URL di download per un singolo documento. Risposta:
  `{ filename, contentLength, url? , retryAfter? }`. `url` presente solo se
  il file è pronto (presigned, da richiamare con GET semplice, senza auth PN
  aggiuntiva); `retryAfter` (secondi) se il file è ancora in fase di
  archiviazione.

  Nota: esiste anche l'endpoint deprecato
  `GET {baseUrl}/delivery-push/{iun}/legal-facts/{legalFactType}/{legalFactId}`
  (richiede anche `legalFactType` nel path) — non usato, si usa solo la
  versione non deprecata che richiede solo `legalFactId`.

## Backend

### `SendLegalFactsService` (`apps/backend/src/channels/send/send-legal-facts.service.ts`)

Nuovo service, stesso pattern di risoluzione env/baseUrl/apiKey/voucher di
`SendStatusSyncService.getEnvAndBaseUrl()` (estratto in helper condiviso se
la duplicazione risulta scomoda in fase di implementazione — decisione da
prendere in fase di scrittura codice, non blocca il design).

- `listLegalFacts(iun: string): Promise<SendLegalFactItem[]>` — chiama
  l'endpoint di elenco, mappa la risposta in
  `{ legalFactId: string, category: LegalFactCategory }[]`. Notifica non
  trovata (404 PN) o errore trasporto → `[]` (log warning, non eccezione).
- `downloadLegalFact(iun: string, legalFactId: string): Promise<SendLegalFactDownloadResult>`
  — chiama l'endpoint di download-metadata; se `url` presente, fa GET del
  contenuto e ritorna `{ ready: true, filename, contentType, buffer }`; se
  `retryAfter` presente ritorna `{ ready: false, retryAfterSeconds }`; su
  errore ritorna `{ ready: false, error: '<messaggio>' }`.

### Endpoint (`notifications-search.controller.ts`)

Estende il controller esistente che già serve il dettaglio recipient
(`GET admin/notifications-search/:recipientId`), stessa guard JWT admin.

- `GET admin/notifications-search/:recipientId/send-legal-facts` — risolve
  l'ultimo attempt SEND del recipient con `iun` valorizzato; se assente
  ritorna `{ items: [] }`; altrimenti chiama `listLegalFacts` e ritorna
  `{ items: SendLegalFactItem[] }`. Sempre HTTP 200 (pattern proxy esterno
  del CLAUDE.md: nessuna eccezione per stati "previsti" come iun assente o
  notifica non trovata su PN).
- `GET admin/notifications-search/:recipientId/send-legal-facts/:legalFactId/download`
  — risolve `iun` come sopra; chiama `downloadLegalFact`. Se `ready`,
  risponde con lo stream binario (`Content-Type` da PN o
  `application/octet-stream`, `Content-Disposition: attachment;
  filename="..."`). Se non pronto o errore, risponde HTTP 200
  `application/json` con `{ ready: false, retryAfterSeconds?, error? }` —
  il frontend distingue i due casi guardando il `Content-Type` della
  risposta prima di trattarla come blob scaricabile.

Nessuna nuova colonna su `NotificationAttempt`: tutto stateless, nessuna
cache persistita (fetch on-demand, vedi sotto).

## Frontend admin

Nel dettaglio destinatario/storico tentativi, sezione canale SEND
(`App.tsx`, area intorno alla `SendStatusBadge` esistente, ~L4949): nuovo
blocco "Documenti disponibili" con bottone "Carica documenti" (fetch
on-demand, non automatico all'apertura pannello — evita chiamate PN non
necessarie e consumo voucher PDND ad ogni apertura dettaglio).

Al click:
1. `GET .../send-legal-facts` → lista righe, una per documento, con
   etichetta italiana della categoria (mappa fissa lato frontend) e bottone
   "Scarica".
2. Click su "Scarica" → `GET .../send-legal-facts/:legalFactId/download`.
   Se risposta binaria, trigger download browser (blob + `<a download>`).
   Se risposta JSON con `retryAfterSeconds`, mostra messaggio "Documento
   non ancora disponibile, riprova tra Ns" al posto del bottone (nessun
   retry automatico — l'operatore riprova manualmente).

**Etichette categoria (IT):**

| category | etichetta |
|---|---|
| `SENDER_ACK` | Presa in carico |
| `DIGITAL_DELIVERY` | Consegna digitale (PEC) |
| `ANALOG_DELIVERY` | Consegna cartacea (cartolina AR) |
| `RECIPIENT_ACCESS` | Accesso del destinatario |
| `PEC_RECEIPT` | Ricevuta PEC |
| `ANALOG_FAILURE_DELIVERY` | Mancata consegna cartacea |
| `NOTIFICATION_CANCELLED` | Notifica annullata |

## Testing

- Unit test `SendLegalFactsService`: mapping categoria, gestione
  `retryAfter`, gestione 404/errore trasporto → `[]`/`{ready:false}`.
- Unit/integration test controller: risoluzione `iun` mancante → `{items:
  []}`; proxy download con mock service `ready:true` → stream con header
  corretti; `ready:false` → JSON 200.
- Nessun test E2E contro PN reale (richiede credenziali ambiente test PN,
  fuori scope di questo lavoro — verifica manuale in ambiente con
  credenziali SEND test, come da pattern già seguito per
  `2026-07-13-send-invio-reale-design.md`).

## Fuori scope

- Generazione locale di PDF/ricevute proprie.
- Ricevute per canali diversi da SEND.
- Cache/persistenza dei documenti scaricati o dei metadati elenco.
- Retry automatico quando PN risponde `retryAfter`.
