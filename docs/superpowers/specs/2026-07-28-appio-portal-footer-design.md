# Avviso canale primario + footer Portale ComunicaPA — design

## Obiettivo

1. Ogni messaggio App IO inviato in **co-consegna parallela** (a corredo di
   PEC/Email/Postalizzazione) riporta automaticamente in coda una frase di
   cortesia che indica su quale canale primario è stata inviata la
   comunicazione ufficiale.
2. Ogni messaggio App IO **e** ogni e-mail/PEC (footer HTML esistente)
   riporta sempre un link al Portale ComunicaPA (SPID/CIE).

## Contesto verificato

- `wrapInHtmlLayout()` (`apps/backend/src/channels/template.helper.ts`) ha
  già un footer condizionale su `options.portalUrl` con testo "Portale del
  Cittadino" — va solo rinominato a "Portale ComunicaPA". Il valore
  `portalUrl` viene risolto con lo stesso pattern duplicato in 4 punti:
  `campaigns.service.ts`, `protocollazione.processor.ts`,
  `email.strategy.ts`, `pec.strategy.ts`
  (`(await this.settings.get<string>('system.citizenPublicUrl')) || null`).
- La co-consegna App IO parallela avviene SOLO in
  `notification.processor.ts` → `sendAppIoMessage()`, chiamata dal branch
  `appIoMode === 'parallel' && isMailChannel` (righe ~232-249), con
  `isMailChannel = EMAIL || PEC || POSTAL`. Il branch `exclusive` non invia
  mai il canale primario, quindi non ha senso una frase di cortesia lì —
  nessuna modifica a quel branch.
- `channel` (job.data.channel, quindi `attempt.channelType`) riflette GIÀ
  l'eventuale dirottamento INAD (es. campagna EMAIL dirottata su PEC ha
  `channel === 'PEC'` e `recipient.pec` già sovrascritto con l'indirizzo
  INAD) — nessuna logica aggiuntiva di dirottamento da scrivere, basta
  leggere `channel` + il campo indirizzo corrispondente sul recipient
  corrente.
- Indirizzo postale: `resolvePhysicalAddress(recipient, physicalAddressConfig)`
  (`payment-config.util.ts`, già importato in `notification.processor.ts`
  per `resolvePaymentData`) ritorna `{ address, zip, municipality, province,
  foreignState }` — stessa funzione usata da `postal.strategy.ts` per
  l'invio reale, garantisce coerenza tra indirizzo dichiarato nella
  cortesia e indirizzo realmente usato per la spedizione.
- **Comportamento su fallimento canale primario (deciso col committente):**
  il blocco co-consegna parallela in `notification.processor.ts` gira
  SEMPRE dopo il tentativo sul canale primario, indipendentemente da esito
  (nessun check su `primaryError` oggi) — comportamento NON cambiato da
  questa feature. La frase di cortesia viene appesa SEMPRE (testo fisso),
  anche se il canale primario è fallito.

## Modifiche

### 1. `apps/backend/src/channels/template.helper.ts`

- Rinomina "Portale del Cittadino" → "Portale ComunicaPA" in
  `wrapInHtmlLayout()` (riga 222).
- Nuova funzione `resolveCitizenPortalUrl(settings: AppSettingsService): Promise<string | null>`
  — incapsula `(await settings.get<string>('system.citizenPublicUrl')) || null`.
  Sostituisce le 4 chiamate duplicate in `campaigns.service.ts`,
  `protocollazione.processor.ts`, `email.strategy.ts`, `pec.strategy.ts`.
- Nuova funzione:
  ```ts
  buildParallelChannelNotice(
    recipient: Recipient,
    primaryChannel: NotificationChannel, // 'EMAIL' | 'PEC' | 'POSTAL' (già channel/attempt.channelType)
    physicalAddressConfig?: Record<string, unknown>,
  ): string
  ```
  Ritorna la frase italiana corrispondente:
  - `PEC` → `Questo messaggio vale come notifica di cortesia per la comunicazione spedita mediante PEC all'indirizzo ${recipient.pec}.`
  - `EMAIL` → `... mediante Email all'indirizzo ${recipient.email}.`
  - `POSTAL` → `... mediante Raccomandata AR all'indirizzo ${formatted}` dove
    `formatted` = `resolvePhysicalAddress()` formattato come
    `${address}, ${zip} ${municipality} (${province})` (indirizzo estero:
    stesso formato, `province` sostituita da `foreignState` se `province`
    assente — nessun nuovo caso, riusa quanto già gestito da
    `resolvePhysicalAddress`).
  - Nessun campo risolvibile (edge case teorico, non dovrebbe accadere se il
    canale primario è partito) → stringa vuota, nessun avviso appeso.
- Nuova funzione `appendAppIoPortalFooter(markdown: string, portalUrl: string | null): string`
  — appende, solo se `portalUrl` è valorizzato:
  ```
  \n\n---\nLa comunicazione ufficiale ed i relativi atti/allegati sono disponibili ed accessibili con SPID/CIE sul [Portale ComunicaPA](${portalUrl}).
  ```
  (markdown, non HTML — App IO consuma `content.markdown`).
- Nuova funzione di comodo `formatAppIoMarkdown(markdown, { parallelNotice, portalUrl })`
  che concatena: `markdown` + (se `parallelNotice` non vuoto:
  `\n\n${parallelNotice}`) + (footer portale via `appendAppIoPortalFooter`).

### 2. `apps/backend/src/queue/notification.processor.ts`

- `sendAppIoMessage()`: dopo aver calcolato `processedMarkdown`, se il
  chiamante è il branch parallelo (nuovo parametro opzionale
  `parallelPrimaryChannel?: NotificationChannel`), costruisce la cortesia
  con `buildParallelChannelNotice()` e il footer con
  `resolveCitizenPortalUrl()` + `appendAppIoPortalFooter()`, poi usa
  `formatAppIoMarkdown()` al posto del markdown grezzo prima di scriverlo
  in `contentPayload.markdown`.
- Il branch `exclusive` (riga ~182) chiama `sendAppIoMessage` SENZA
  `parallelPrimaryChannel` → solo footer portale, mai cortesia (coerente:
  lì il canale primario non viene inviato).
- Il branch `parallel` (riga ~240) passa `parallelPrimaryChannel: channel`.

### 3. `apps/backend/src/channels/app-io/app-io.strategy.ts`

- Canale APP_IO come canale primario (non co-consegna): solo footer
  portale via `formatAppIoMarkdown()` (nessuna cortesia — non esiste un
  "canale primario" diverso da App IO stesso).

### 4. `apps/backend/src/campaigns/campaigns.service.ts`

- Funzione di anteprima wizard (step6, quella che già chiama
  `processTemplate`/`wrapInHtmlLayout` per mostrare il messaggio finale):
  replica la stessa logica per la preview App IO (con e senza co-consegna
  parallela a seconda della config canale), così l'operatore vede
  esattamente cortesia+footer prima di lanciare la campagna.
- Sostituisce l'inline `system.citizenPublicUrl` (riga 268) con
  `resolveCitizenPortalUrl()`.

### 5. `apps/backend/src/channels/email/email.strategy.ts`, `pec/pec.strategy.ts`, `queue/protocollazione.processor.ts`

- Sostituiscono l'inline `system.citizenPublicUrl` con
  `resolveCitizenPortalUrl()` (solo dedup, nessun cambio di comportamento —
  il footer HTML già esiste, solo la label cambia via modifica #1).

### 6. `apps/backend/src/channels/template.helper.spec.ts`

- Aggiorna gli assert esistenti "Portale del Cittadino" → "Portale
  ComunicaPA".
- Nuovi test: `buildParallelChannelNotice` per PEC/EMAIL/POSTAL (incl.
  indirizzo estero), `appendAppIoPortalFooter` con/senza `portalUrl`,
  `formatAppIoMarkdown` combinazione completa.

## Fuori scope

- Nessun nuovo setting in UI — riusa `system.citizenPublicUrl` già
  esistente e configurato (bootstrapOnly, da `CITIZEN_ORIGIN`).
- Nessuna modifica al comportamento esistente di invio/skip App IO
  parallelo su fallimento canale primario (resta invariato, solo il
  contenuto del markdown cambia).
- Nessuna modifica a SEND (matrice comportamenti: `isMailChannel` esclude
  già SEND, App IO n/a per quel canale).

## Test manuali (oltre agli unit test)

- Campagna PEC con App IO parallela → verificare markdown ricevuto include
  cortesia PEC + footer portale.
- Campagna POSTAL con App IO parallela, indirizzo estero → verificare
  formattazione senza provincia, con stato estero.
- Campagna POSTAL con App IO parallela, canale primario fallito
  (es. provider GlobalCom down) → verificare che App IO parte comunque con
  cortesia fissa (nessun cambiamento rispetto a comportamento attuale).
- Anteprima wizard step6 App IO → verificare che il testo mostrato
  combaci esattamente con quanto verrà inviato.
