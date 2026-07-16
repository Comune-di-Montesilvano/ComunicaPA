# INAD — singola interrogazione domicilio digitale

## Contesto

INAD (Indice Nazionale Domicili Digitali) è fonte di verità assoluta per il
domicilio digitale del cittadino. Scope finale (non in questa fase): se un
cittadino ha eletto domicilio digitale su INAD, quel domicilio diventa
l'unico canale di invio da usare, tranne per SEND (che risolve il domicilio
digitale legale per conto proprio tramite PN). Questo comportamento — dove
agganciarlo nel flusso campagna/destinatario — è deliberatamente **fuori
scope** qui e verrà disegnato in una fase successiva.

Questa fase copre solo: far funzionare una singola interrogazione reale
verso l'API INAD, verificabile a mano dalla UI admin.

Scaffolding già esistente (non toccato nella sua struttura):
`apps/backend/src/channels/inad/inad.service.ts` (solo `getVoucher()`),
`inad.module.ts`, settings `inad.{test,prod}.purposeId`, tab Impostazioni →
INAD con test voucher per env (`apps/frontend-admin/src/App.tsx`).

## Spec API (verificata su raw YAML, non su riassunto)

Fonte: `https://raw.githubusercontent.com/AgID/INAD_API_Extraction/main/inad_api_extraxtion.yaml`
(OpenAPI 3.0.1, AgID).

- Server: `https://api.inad.gov.it/rest/inad/v1/domiciliodigitale` (unico
  host in spec, marcato "esempio, va recuperato da PDND" — usato invariato
  per prod; non implementiamo distinzione test/prod in questa fase, vedi
  sotto).
- Auth: **solo** `bearerAuth` (JWT voucher PDND) — a differenza di SEND,
  nessun `x-api-key` separato.
- Endpoint singola interrogazione: `GET /extract/{codice_fiscale}`
  - query param obbligatorio `practicalReference` (string libera,
    "riferimento del procedimento amministrativo")
  - risposta 200: `Response_Request_Digital_Address`:
    ```json
    {
      "codiceFiscale": "RRANGL74M28R701V",
      "since": "2017-07-21T17:32:28Z",
      "digitalAddress": [
        {
          "digitalAddress": "example@pec.it",
          "practicedProfession": "Avvocato",
          "usageInfo": { "motivation": "CESSAZIONE_VOLONTARIA", "dateEndValidity": "..." }
        }
      ]
    }
    ```
  - risposta 404: nessun domicilio digitale associato al CF (non è un errore
    applicativo — CF senza domicilio eletto è un esito legittimo)
  - altri status (400/401/403/500/503): `Errore` (`status`, `type`, `detail`)
    → propagati come eccezione con status+body, stesso pattern di
    `pdnd-auth.service.ts`

## Decisioni di scope (confermate in brainstorming)

- **Solo ambiente prod.** Nessun toggle test/UAT per questa chiamata: la
  spec espone un solo host, e per ora non serve distinguere. Usa
  `inad.prod.purposeId` già esistente per il voucher. I settings
  `inad.test.purposeId`/`inad.prod.purposeId` e il relativo test voucher
  per-env restano invariati (non li tocchiamo).
- **Pura lettura, nessuna persistenza.** La query non scrive nulla su DB
  (nessun campo domicilio su recipient/campaign) — solo richiesta/risposta
  mostrata a video. La logica "domicilio come canale unico" è behaviour
  futuro.
- **`practicalReference` fisso, hardcoded lato backend** (non un input
  utente né un setting): stringa costante, es.
  `'comunicapa-verifica-domicilio'`. La futura verifica puntuale (stile
  App IO, valore immesso dall'utente) e l'uso per invio massivo (oggetto
  campagna) sono fuori scope qui.
- **Nessun campo API Key in UI**: la spec non la prevede per INAD (solo
  bearer voucher PDND).

## Componenti

### 1. `InadService` (`apps/backend/src/channels/inad/inad.service.ts`)

Nuovo metodo:

```ts
async extractDigitalAddress(codiceFiscale: string): Promise<InadExtractResult>
```

- recupera voucher: `this.getVoucher('prod')` (già esiste, usa
  `inad.prod.purposeId`)
- `GET https://api.inad.gov.it/rest/inad/v1/domiciliodigitale/extract/{codiceFiscale}?practicalReference=comunicapa-verifica-domicilio`
  con header `Authorization: Bearer <voucher>`
- 200 → `{ found: true, data: <body parsato> }`
- 404 → `{ found: false }`
- altro status non-ok → `throw new Error('INAD extract fallito: HTTP <status> — <body troncato>')`

Tipo `InadExtractResult` definito localmente nel file service (no nuovo
file shared-types per questo — struttura usata solo qui per ora).

### 2. Controller (`apps/backend/src/settings/settings.controller.ts`)

Nuovo endpoint accanto a `testInadConnection`:

```
POST admin/settings/inad/prod/extract
body: { codiceFiscale: string }
```

- valida `codiceFiscale` presente (altrimenti `BadRequestException`, come
  gli altri parametri di path/env già validati in questo controller)
- chiama `inadService.extractDigitalAddress(codiceFiscale)`
- risponde sempre HTTP 200 con `{ success: boolean, found?: boolean, data?: ..., message?: string }`
  (pattern identico a `testServicePurposeConnection`: mai eccezione non-2xx
  su errori "previsti" dell'endpoint di test in Impostazioni)

### 3. Frontend admin — tab Impostazioni → INAD (`App.tsx`)

Dentro il fieldset "Produzione" esistente (non nel fieldset "Collaudo"):
sotto il bottone "Test connessione (voucher PDND)" già presente, aggiungo:

- input testo "Codice Fiscale" (nuovo state `settInadExtractCf`)
- bottone "Interroga domicilio digitale" (nuovo state
  `settInadExtracting: boolean`, `settInadExtractResult`)
- box risultato: se `found: true` mostra domicilio/i (digitalAddress,
  professione se presente); se `found: false` mostra "Nessun domicilio
  digitale associato"; se errore mostra messaggio

Aggiorno l'alert in cima al tab: non più "specifiche non ancora definite"
(ora note) — testo tipo: "Interrogazione singola disponibile. La logica di
scelta canale in base al domicilio eletto è ancora da implementare."

## Test

- Unit test `InadService.extractDigitalAddress`: mock `fetch` (200 con
  domicilio, 200 con array vuoto se capita, 404, 500) — verifica
  found/data/throw nei tre casi.
- Nessun test e2e reale (richiede credenziali PDND/INAD prod vere): verifica
  manuale dal bottone UI quando le credenziali saranno disponibili in un
  ambiente con accesso reale.

## Fuori scope (fasi successive)

- Comportamento "domicilio digitale eletto = unico canale" nel flusso
  campagna/destinatario.
- Endpoint di verifica puntuale stile App IO (CF/practicalReference immessi
  da operatore per singolo cittadino, fuori da Impostazioni).
- Uso di `practicalReference` = oggetto campagna per invio massivo.
- Estrazione multipla (`/listDigitalAddress`, fino a 1000 CF, asincrona).
- Distinzione test/UAT per questa chiamata (se INAD fornirà un host di
  collaudo separato in futuro).
