# Blocco lancio campagna: allegati senza placeholder nel template

Data: 2026-07-23

## Problema

Se una campagna ha allegati configurati ma il template (corpo email/pec/app io)
non contiene né `%%elenco_allegati%%` né tutti i `%%allegatoN%%` corrispondenti,
il destinatario riceve una notifica senza alcun modo di scaricare gli allegati
allegati alla campagna. Nessun blocco esiste oggi per questo caso — va aggiunto,
sia lato wizard (UX) sia lato server (fonte di verità, contro bozze vecchie o
bypass del wizard).

## Regola di validazione

Data una stringa `body` e un numero `count` di allegati configurati sulla
campagna:

- `count === 0` → sempre valido (nessun vincolo se non ci sono allegati)
- valido se `body` contiene `%%elenco_allegati%%`
- valido se `body` contiene `%%allegatoN%%` per **ogni** N da 1 a `count`
  (non basta un sottoinsieme)
- altrimenti **non valido** → blocca

Implementata come funzione pura, duplicata (non condivisa: backend e
frontend-admin sono bundle separati senza codice condiviso per questa logica,
coerente con `@comunicapa/shared-types` usato solo per interfacce, non
funzioni):

```ts
function hasValidAttachmentPlaceholders(body: string, count: number): boolean {
  if (count === 0) return true;
  if (body.includes('%%elenco_allegati%%')) return true;
  for (let i = 1; i <= count; i++) {
    if (!body.includes(`%%allegato${i}%%`)) return false;
  }
  return true;
}
```

## Canali coinvolti

Solo i canali dove il corpo del template è contenuto realmente mostrato al
destinatario: **EMAIL, PEC, APP_IO**. Esclusi:

- **POSTAL** (primario): il corpo non è mai il contenuto reale (la lettera è
  generata dagli allegati PDF, vedi gotcha CLAUDE.md "POSTAL:
  `channelConfig.body`/`subject` NON sono il contenuto reale inviato").
- **SEND**: nessun corpo, solo oggetto: allegato è il contenuto stesso (già
  obbligatorio via `checkAttachmentsBlocking` esistente).

**Corpo App IO di co-consegna differenziata** (`bodyOverride` su
`secondaryChannels`, disponibile quando primario è EMAIL/PEC/POSTAL e
l'operatore attiva "Differenzia oggetto e testo per App IO"): validato
**indipendentemente** dal corpo primario, stesso `count` di allegati — perché
è contenuto App IO realmente mostrato, a prescindere dal canale primario
(incluso POSTAL, che pure è escluso per il proprio corpo primario).

Se la co-consegna App IO non è differenziata, usa il corpo del canale
primario (fallback già esistente in `renderAppIoCoDeliveryPreview`) — nessun
controllo aggiuntivo necessario in quel caso (il corpo primario è già
validato, se applicabile).

## Backend

**`apps/backend/src/channels/template.helper.ts`**: aggiungere ed esportare
`hasValidAttachmentPlaceholders(body, count)` come sopra.

**`apps/backend/src/campaigns/campaigns.service.ts`**, dentro
`checkAttachmentsBlocking(campaign)` (riga 320), dopo il check esistente
sull'allegato obbligatorio SEND/POSTAL e dopo `findMissingAttachments`:

```ts
const attachmentCount = resolveAttachmentsConfig(campaign.channelConfig).length;

if (
  ['EMAIL', 'PEC', 'APP_IO'].includes(campaign.channelType) &&
  !hasValidAttachmentPlaceholders((campaign.channelConfig?.['body'] as string) || '', attachmentCount)
) {
  return {
    blocked: true,
    message: `Impossibile avviare: il template non contiene il blocco "Elenco Allegati" (%%elenco_allegati%%) né tutti i link singoli (%%allegato1%%...%%allegato${attachmentCount}%%) per i ${attachmentCount} allegati configurati. Aggiungi il placeholder al Passo 4 prima di rilanciare.`,
  };
}

const appIoConfig = resolveSecondaryAppIoConfig(campaign.channelConfig) as { bodyOverride?: string } | undefined;
if (
  appIoConfig?.bodyOverride &&
  !hasValidAttachmentPlaceholders(appIoConfig.bodyOverride, attachmentCount)
) {
  return {
    blocked: true,
    message: `Impossibile avviare: il testo App IO differenziato non contiene il blocco "Elenco Allegati" né tutti i link singoli per i ${attachmentCount} allegati configurati. Correggilo al Passo 4 prima di rilanciare.`,
  };
}
```

Pattern `{blocked:true, message}` (mai eccezione non-2xx), stesso motivo già
documentato per il resto di `checkAttachmentsBlocking` (proxy esterno
sostituisce il body delle risposte non-2xx).

## Frontend (wizard, `App.tsx`)

Helper client-side identico (duplicato, no import cross-bundle):

```ts
function hasValidAttachmentPlaceholders(body: string, count: number): boolean {
  if (count === 0) return true;
  if (body.includes('%%elenco_allegati%%')) return true;
  for (let i = 1; i <= count; i++) {
    if (!body.includes(`%%allegato${i}%%`)) return false;
  }
  return true;
}
```

Calcolato in step4 (dove vivono `wizBody`, `wizAttachments`,
`wizAppIoBodyOverride`, `wizAppIoDifferentiate`):

```ts
const wizAttachmentCount = wizAttachments.filter(a => a.key).length;
const wizPrimaryBodyMissingPlaceholder =
  (wizChannel === 'EMAIL' || wizChannel === 'PEC' || wizChannel === 'APP_IO') &&
  !hasValidAttachmentPlaceholders(wizBody, wizAttachmentCount);
const wizAppIoBodyMissingPlaceholder =
  wizAppIoMode !== 'none' && wizAppIoDifferentiate &&
  !hasValidAttachmentPlaceholders(wizAppIoBodyOverride, wizAttachmentCount);
```

- Aggiungere `wizPrimaryBodyMissingPlaceholder ||
  wizAppIoBodyMissingPlaceholder` alla condizione `disabled` di **entrambi** i
  bottoni "Riepilogo" (righe 8267 e 8475, stesso duplicato già esistente nel
  file).
- Alert `alert-warning` (stesso stile di `wizAppIoBodyLenInvalid`,
  riga ~8385) sotto l'editor del corpo primario quando
  `wizPrimaryBodyMissingPlaceholder`, e sotto il textarea App IO override
  (riga ~8451) quando `wizAppIoBodyMissingPlaceholder`. Testo: elenco allegati
  mancanti o placeholder singoli mancanti, invito a usare il pulsante
  "Elenco Allegati" o i token `Link: <etichetta>` già presenti nella toolbar
  `TemplateEditor` (riga 8332-8333).

## Test

- `template.helper.spec.ts`: casi `hasValidAttachmentPlaceholders` — 0
  allegati, elenco presente, tutti i singoli presenti, singoli parziali
  (deve fallire), nessuno dei due.
- `campaigns.service.spec.ts`: `checkAttachmentsBlocking` — campagna
  EMAIL/PEC/APP_IO con allegati e body senza placeholder → blocked; con
  `%%elenco_allegati%%` → non blocked; con tutti i singoli → non blocked; con
  solo alcuni singoli → blocked. Co-consegna App IO differenziata con
  `bodyOverride` senza placeholder → blocked anche se corpo primario è ok.
  POSTAL/SEND con allegati e body senza placeholder → NON blocked (esclusi
  dalla regola).
