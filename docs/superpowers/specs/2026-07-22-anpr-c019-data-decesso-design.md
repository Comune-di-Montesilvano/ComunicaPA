# ANPR C019 — data decesso + riorganizzazione Impostazioni ANPR

## Problema

C002 (già integrato) restituisce solo `esistenza in vita: SI/NO` — nessuna
data di decesso, confermato dalla documentazione ufficiale Sogei
(`tinn/pdnd/documentazioneC002.pdf`, pag. 3: "I dati restituiti dal servizio
sono: generalità, idANPR, esistenza in vita: valore SI/NO, residenza").

C019 "Servizio di accertamento esistenza in vita" è un e-service PDND
**diverso** (propria finalità/purposeId, non condivisa con C002) che
restituisce in più la data decesso (`tinn/pdnd/documentazioneC019.pdf`,
pag. 3: "La risposta del servizio prevede i seguenti valori: SI/NO,
Generalità, IdANPR, data decesso"). Stesso schema `RichiestaE002`/
`RispostaE002OK` di C002 (stesso pattern di sicurezza AUDIT_REST_02 —
digest della TrackingEvidence nella client assertion, voucher Bearer
standard), solo URL/aud diversi:

- aud: `https://modipa.anpr.interno.it/govway/rest/in/MinInternoPortaANPR/C019-servizioAccertamentoEsistenzaVita/v1`
- endpoint: `https://modipa.anpr.interno.it/govway/rest/in/MinInternoPortaANPR-PDND/C019-servizioAccertamentoEsistenzaVita/v1/anpr-service-e002`

Verificato dal vivo in produzione (purposeId reale, CF deceduto reale
— non riportato per tutela dei dati personali) durante questa sessione:
chiamata riuscita, stesso schema risposta di C002.

In aggiunta, la sezione Impostazioni → ANPR esistente ha un residuo
morto: fieldset "Collaudo (UAT)" (`anpr.test.purposeId`) mai realmente
utilizzato — `AnprService.getResidenza()` chiama sempre e solo l'ambiente
prod (hardcoded), l'ambiente test non è mai raggiungibile da questo codice.

## Scope

- Nuovo metodo `AnprService.getEsistenzaInVita()` per C019.
- `DomicilioService` chiama C019 automaticamente ma **solo** quando C002 ha
  già restituito `found:true` e `esistenza in vita: N` — mai per soggetti in
  vita (risparmia chiamate PDND, C019 è una finalità/quota separata).
- Pannello "Verifica Anagrafica": mostra la data decesso sotto al badge
  "Deceduto" se C019 la restituisce; se C019 fallisce o non è configurato,
  avviso esplicito (mai silenzioso) — badge "Deceduto" (da C002) resta
  comunque visibile e affidabile in ogni caso.
- Riorganizzazione Impostazioni ANPR: un blocco unico con due Purpose ID
  distinti (C002, C019) ciascuno con test dedicato, rimosso il fieldset
  "Collaudo (UAT)" morto. Chiave `anpr.prod.purposeId` rinominata
  `anpr.c002.purposeId` (valore da re-inserire manualmente in UI dopo il
  deploy — nessuna migrazione automatica per KV settings, scelta esplicita
  dell'utente per chiavi pulite).

Fuori scope: uso di C019/data decesso nel flusso di invio campagne (wizard,
strategy di canale) — resta confinato al pannello di consultazione manuale
"Verifica Anagrafica". Ambiente test/UAT ANPR — resta non supportato (come
oggi per C002).

## Design

### Backend

**`settings.registry.ts`**
- Rimuovere `anpr.test.purposeId`.
- Rinominare `anpr.prod.purposeId` → `anpr.c002.purposeId`.
- Aggiungere `anpr.c019.purposeId: { type: 'string', default: '' }`.

**`anpr.types.ts`** — nuovo tipo:
```ts
export interface AnprEsistenzaInVitaResult {
  found: boolean;
  data?: {
    idANPR?: string;
    generalita: AnprGeneralita;
    esistenzaInVita?: 'S' | 'N';
    dataDecesso?: string;
  };
}
```

**`anpr.service.ts`**
- `getResidenza()`: la lettura del purposeId passa da
  `anpr.prod.purposeId` a `anpr.c002.purposeId` (unica modifica alla
  funzione esistente — URL/aud C002 invariati).
- Nuovo metodo `getEsistenzaInVita(codiceFiscale, operatorUsername):
  Promise<AnprEsistenzaInVitaResult>`, stessa struttura di `getResidenza()`
  (TrackingEvidence → digest → voucher con digest → Agid-JWT-Signature →
  POST), con:
  - `C019_AUD`/`C019_ENDPOINT` come da sezione Problema.
  - `datiRichiesta.casoUso: 'C019'`.
  - purposeId da `anpr.c019.purposeId`.
  - Risposta: `soggetto.infoSoggettoEnte` cercato per chiave che include
    "vita" (stesso pattern del frontend esistente) per `esistenzaInVita`;
    campo dedicato `dataDecesso` letto da `soggetto` di primo livello (la
    doc C019 lo elenca come dato di risposta a sé, non dentro
    `infoSoggettoEnte` — verificare la forma esatta al primo payload reale
    in Task di implementazione con `LOG_LEVEL=debug`, loggando la risposta
    grezza come già fa `getResidenza()`, prima di fissare il parsing).
  - Stesso trattamento errori di `getResidenza()`: HTTP 404 → `found:
    false`; altri non-2xx → throw.

**`domicilio.service.ts`**
- Dopo aver ottenuto l'esito di `anprService.getResidenza()`
  (`Promise.allSettled` esistente), se il risultato è `fulfilled` con
  `found:true` e `infoSoggettoEnte` contiene una chiave che include "vita"
  con `valore === 'N'`, chiamare in aggiunta
  `anprService.getEsistenzaInVita(codiceFiscale, operatorUsername)`,
  in un proprio `try/catch` indipendente (un fallimento qui non deve
  azzerare il resto del risultato, stesso principio delle altre fonti).
- Nuovo campo su `DomicilioSearchResult`:
  `anprEsistenzaInVita?: { success: boolean; dataDecesso?: string;
  message?: string }` — presente SOLO quando la chiamata C019 è stata
  effettivamente tentata (cioè quando C002 ha già segnalato deceduto).

**`settings.controller.ts`**
- Sostituire `POST anpr/:env/test-connection` con due rotte dedicate,
  senza parametro env (l'ambiente è sempre prod per ANPR):
  - `POST anpr/c002/test-connection` → legge `anpr.c002.purposeId`,
    `pdndAuth.getVoucher('prod', purposeId, true)`.
  - `POST anpr/c019/test-connection` → legge `anpr.c019.purposeId`,
    stesso pattern.
- Entrambe restituiscono lo stesso shape di oggi (`{ success, message }`).

### Frontend (`apps/frontend-admin/src/App.tsx`)

**Stato Impostazioni**
- Rimuovere `settAnprTestPurposeId`.
- Rinominare `settAnprProdPurposeId` → `settAnprC002PurposeId`, aggiungere
  `settAnprC019PurposeId`.
- `settAnprTesting`/`settAnprTestResult`: tipo `'c002' | 'c019' | null` al
  posto di `'test' | 'prod' | null`.
- Effect di caricamento: legge `anpr.c002.purposeId` e
  `anpr.c019.purposeId`.
- Payload di salvataggio: invia entrambe le nuove chiavi (rimossa
  `anpr.test.purposeId`).
- `handleTestAnprConnection('c002' | 'c019')` chiama le due nuove rotte.

**Sezione Impostazioni → ANPR** (righe ~11221-11288)
- Un solo `alert` introduttivo aggiornato (rimosso riferimento a
  "Collaudo"/ambiente, resta il riferimento al client PDND condiviso).
- Array delle due fieldset diventa `[{ label: 'C002 - Servizio di
  Comunicazione', key: 'c002', purposeId: settAnprC002PurposeId, ... },
  { label: 'C019 - Accertamento Esistenza in Vita', key: 'c019',
  purposeId: settAnprC019PurposeId, ... }]` — stessa struttura JSX di
  oggi (fieldset + input + bottone test + risultato), solo dati diversi.
  Fieldset "Collaudo (UAT)" rimossa.
- Fieldset "Tracciamento" invariata (condivisa tra C002 e C019, stesso
  claim `Agid-JWT-TrackingEvidence`).

**Tab/etichette**
- `SettingsTab` type e nav (riga 61): label `'ANPR (C002)'` →
  `'ANPR (C002/C019)'`.
- Header pannello Impostazioni (riga ~10645): `'Integrazione ANPR
  (Servizio C002 - Servizio di Comunicazione)'` → `'Integrazione ANPR
  (C002 - Comunicazione, C019 - Esistenza in Vita)'`.

**Pannello "Verifica Anagrafica"** (righe ~9872-9903)
- Tipo locale del risultato (riga ~897): aggiungere
  `anprEsistenzaInVita?: { success: boolean; dataDecesso?: string;
  message?: string }` accanto a `anpr`.
- Nel blocco badge "Deceduto" (dove oggi si tenta già
  `vitaInfo.valoreData`, mai popolato da C002): quando
  `vitaInfo.valore === 'N'`:
  - se `domicilioResult.anprEsistenzaInVita?.success &&
    .dataDecesso` → riga aggiuntiva sotto il badge: "Decesso avvenuto il
    {data formattata}".
  - se `anprEsistenzaInVita` presente ma `success:false` → avviso
    esplicito piccolo (es. `text-warning`): "Data decesso non disponibile
    ({message})".
  - se `anprEsistenzaInVita` assente (C002 non ha segnalato deceduto,
    quindi C019 non è mai stato chiamato) → nessuna riga aggiuntiva
    (comportamento invariato per soggetti in vita).

## Test

Nessuna suite automatica esistente copre `AnprService`/`DomicilioService`
con mock HTTP (le chiamate PDND reali non sono mockate nei test esistenti
del repo — stesso limite già presente per `getResidenza()`). Verifica
manuale in browser dopo l'implementazione:
1. Impostazioni → ANPR: re-inserire il Purpose ID C002 esistente nella
   chiave rinominata, inserire il nuovo Purpose ID C019
   (`d84007fd-8ac0-413c-bbce-46eeaf411ef0`, già verificato funzionante),
   testare entrambi i bottoni "Test connessione".
2. Verifica Anagrafica con un CF deceduto reale (non riportare il CF in
   commit/documentazione) — atteso: badge "Deceduto" con data decesso
   sotto, se il campo è effettivamente valorizzato da ANPR per questo
   soggetto (non garantito per ogni CF: il dato dipende da cosa il comune
   ha registrato all'atto della cancellazione anagrafica).
3. Verifica Anagrafica con un CF in vita (es. un CF AIRE reale già
   utilizzato per il test dell'indirizzo estero, non riportato) — atteso:
   nessuna chiamata C019 (verificare nei log backend con `LOG_LEVEL=debug`
   che non compaia una seconda richiesta ANPR), nessuna riga aggiuntiva
   nel pannello.
4. Type-check backend e frontend-admin puliti.

**Esito verifica reale (post-implementazione):** su un CF deceduto reale
verificato dal vivo, C019 risponde `esistenzaInVita: "N"` correttamente ma
`dataDecesso` risulta assente dal payload — non un bug di parsing (il
campo è letto correttamente da `soggetto.dataDecesso` come da schema),
ANPR semplicemente non ha quella data registrata per questo soggetto.
Confermato che questo è probabilmente il caso più comune in pratica (non
un'eccezione): il pannello gestisce esplicitamente un terzo stato oltre
a "data trovata"/"C019 fallito" — "C019 riuscito ma senza data" (badge
"Deceduto" + riga muted "Data decesso non disponibile in ANPR"), aggiunto
durante l'implementazione rispetto al design originale a due soli stati.
