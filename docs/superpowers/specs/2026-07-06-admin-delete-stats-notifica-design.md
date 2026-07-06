# Elimina Campagna, Statistiche Multicanale, Dettaglio Notifica — Design

## Obiettivo

Tre feature indipendenti nell'area admin di ComunicaPA:

1. **Elimina campagna** (solo admin): cancella campagna, destinatari, tentativi di invio e allegati su disco.
2. **Statistiche multicanale**: nel dettaglio campagna, breakdown per canale/co-consegna App IO (oggi assente — `getStats()` non guarda mai `NotificationAttempt`).
3. **Dettaglio notifica**: nella ricerca notifiche, click su una riga apre un pannello con storico tentativi ed **anteprima ricostruita del messaggio realmente inviato** (oggi cliccare una riga non fa nulla).

## Stato attuale (rilevante)

- `CampaignsController`/`CampaignsService`: nessuna route `DELETE`, nessun metodo di rimozione.
- Cascade DB: `Recipient.campaign` e `NotificationAttempt.recipient` hanno `onDelete: 'CASCADE'` a livello di entity — cancellare una `Campaign` cascata automaticamente su `Recipient`→`NotificationAttempt` **se la migration reale applicata in produzione riflette questo vincolo** (da verificare, non solo l'entity TypeORM).
- Allegati su disco (`getUploadsDir(campaignId)`) NON sono coperti da cascade DB — cancellazione manuale necessaria.
- Pattern admin-only esistente: `@Roles('admin')` a livello di **singolo metodo** dentro un controller altrimenti `@Roles('user','admin')` (es. `io-services.controller.ts`, `mail-configs.controller.ts`).
- `getStats()` ritorna solo `{campaignId, totalRecipients, totalSent, totalDownloaded, downloadPercentage, lastDownloadAt}`, letti da colonne denormalizzate su `Campaign` (`sentCount`/`failedCount`) e da `Recipient.downloadCount`. Non tocca mai `NotificationAttempt`.
- Il segnale di co-consegna App IO esiste già, solo dentro `NotificationAttempt.responsePayload` (scritto da `notification.processor.ts`):
  - `responsePayload.appIo = {success, messageId?, error?}` — scritto ogni volta che la co-consegna è stata tentata (parallela o esclusiva).
  - `responsePayload.deliveredVia = 'APP_IO'` — scritto **solo** in modalità esclusiva quando riuscita (il canale primario viene saltato).
  - In modalità parallela riuscita, `deliveredVia` NON viene impostato: il segnale "consegnato anche via App IO" è `attempt.status === SUCCESS && responsePayload.appIo?.success === true && responsePayload.deliveredVia !== 'APP_IO'`.
- `notifications-search.service.ts::search()` interroga solo `Recipient` con `leftJoinAndSelect('recipient.campaign', 'campaign')` — non tocca mai `NotificationAttempt`. Nessuna route by-id.
- `previewMessage()` (già esistente, piano "Fix Anteprima Email/PEC") costruisce un `Recipient` transitorio e chiama `processTemplate`/`wrapInHtmlLayout`. La logica di rendering è già isolata ma accoppiata alla costruzione del destinatario transitorio — va estratta in un helper condiviso riusabile anche con un `Recipient` reale.
- Nessun componente modal esiste in `App.tsx` (5182 righe, un solo file) — ogni conferma usa `window.confirm()` nativo; nessun modal riusabile da cui partire.

## Sezione 1 — Statistiche multicanale

### Backend

Nuovo metodo `CampaignsService.getChannelBreakdown(campaignId): Promise<ChannelBreakdownDto | null>`:
- Ritorna `null` se la campagna non ha co-consegna App IO configurata (nessuna entry `secondaryChannels`/`appIo` in `channelConfig`) — evita di calcolare/mostrare un breakdown vuoto per campagne normali.
- Altrimenti, carica `{status, responsePayload}` di tutti i `NotificationAttempt` della campagna (query mirata, non l'intera riga) e classifica ciascuno in esattamente una delle 5 categorie:

```ts
interface ChannelBreakdownDto {
  primaryOnly: number;       // primario riuscito, App IO non consegnato
  both: number;              // primario riuscito + App IO riuscito (parallela)
  appIoOnly: number;         // primario saltato, consegnato solo via App IO (esclusiva)
  appIoDespitePrimaryFail: number; // primario fallito ma App IO riuscito (edge case, vedi test I2 esistente)
  neither: number;           // entrambi falliti
}
```

Logica di classificazione per singolo attempt:
```ts
const appIo = responsePayload?.appIo as { success?: boolean } | undefined;
const deliveredViaAppIo = responsePayload?.deliveredVia === 'APP_IO';
const primarySucceeded = status === AttemptStatus.SUCCESS && !deliveredViaAppIo;
const appIoSucceeded = !!appIo?.success;

if (primarySucceeded && appIoSucceeded) bucket = 'both';
else if (primarySucceeded && !appIoSucceeded) bucket = 'primaryOnly';
else if (deliveredViaAppIo && appIoSucceeded) bucket = 'appIoOnly';
else if (status === AttemptStatus.FAILED && appIoSucceeded) bucket = 'appIoDespitePrimaryFail';
else bucket = 'neither';
```

Nuova route `GET /admin/campaigns/:id/channel-stats` → `{ campaignId, breakdown: ChannelBreakdownDto | null }`.

### Frontend

Nel dettaglio campagna, sotto il blocco "Stato dell'Invio" esistente (`App.tsx:4917-4936`), nuovo blocco "Dettaglio Consegna Multicanale" — fetch di `/campaigns/:id/channel-stats` al caricamento della pagina, renderizzato **solo se** `breakdown !== null`. Cinque righe con conteggio ed etichetta (icona diversa per categoria, coerente con lo stile esistente `fas fa-check`/`fas fa-times`).

### Testing

- Unit test su `getChannelBreakdown()`: un caso per ciascuna delle 5 categorie con `NotificationAttempt` mock, più il caso "nessuna co-consegna configurata → null" (skip query).
- Nessun test frontend runtime nel repo (solo `tsc`) — verifica manuale nel browser con una campagna di co-consegna reale dopo il deploy.

---

## Sezione 2 — Elimina campagna (solo admin)

### Backend

`CampaignsController`:
```ts
@Delete(':id')
@Roles('admin')
remove(@Param('id', ParseUUIDPipe) id: string): Promise<{ deleted: true }> {
  return this.campaignsService.remove(id);
}
```

`CampaignsService.remove(id)`:
1. `findOneBy({id})` — 404 se non esiste.
2. `fs.rm(getUploadsDir(id), { recursive: true, force: true })` — rimuove allegati su disco (idempotente, `force:true` non fallisce se la cartella non esiste).
3. `campaignRepo.delete(id)` — cascade DB su `Recipient`→`NotificationAttempt`.
4. Ritorna `{deleted: true}`.

**Verifica pre-implementazione (task del piano):** controllare la migration reale che ha creato le FK `recipients.campaign_id` e `notification_attempts.recipient_id`, confermando `ON DELETE CASCADE` nel SQL applicato (non solo nell'entity TypeORM — `synchronize` in dev applica l'entity direttamente, ma la produzione gira da migration). Se manca, aggiungere una migration che la imposta prima di procedere con la route.

Job BullMQ già in coda per quella campagna al momento della cancellazione: se processati dopo, falliranno su `Campaign ${id} not found` / `Recipient ${id} not found` (comportamento già esistente in `notification.processor.ts:52-60`) e finiranno tra i job falliti — **comportamento accettato esplicitamente**, nessuna pulizia coda aggiuntiva in questo piano.

### Frontend

- Bottone "Elimina" (icona cestino, `btn-outline-danger`) nella riga azioni della lista campagne (`App.tsx:2889-2908`, accanto a "Duplica"/"Riprendi") — visibile solo se `role === 'admin'`.
- Stesso bottone nel dettaglio campagna, in fondo al blocco metadata (`App.tsx:4972-4991`), sempre solo-admin.
- `confirm('Eliminare definitivamente la campagna "${name}"? Verranno cancellati destinatari, tentativi di invio e allegati. Azione irreversibile.')` prima della chiamata DELETE — stesso pattern nativo già usato ovunque nel file.
- Dopo cancellazione riuscita: refresh lista campagne (`fetchCampaigns()`), se si era nel dettaglio torna alla lista.

### Testing

- Unit test `remove()`: cancellazione riuscita (verifica chiamata a `fs.rm` con il path corretto e a `campaignRepo.delete`), 404 se campagna non esiste.
- Controller: verifica che la route sia raggiungibile solo con ruolo admin (test già esistente nel file per pattern analoghi, es. `io-services.controller.spec.ts`).

---

## Sezione 3 — Dettaglio notifica

### Backend

**Estrazione condivisa** (nessuna duplicazione): refactor di `previewMessage()` in `campaigns.service.ts` per delegare il rendering vero e proprio a un helper privato:
```ts
private async renderMessage(
  channelType: NotificationChannel,
  subjectTemplate: string,
  bodyTemplate: string,
  attachmentLabels: string[],
  recipientLike: Pick<Recipient, 'id' | 'codiceFiscale' | 'fullName' | 'email' | 'pec' | 'extraData'>,
  retentionDays: number | null,
  format?: 'html' | 'markdown',
): Promise<PreviewMessageResult>
```
`previewMessage()` (dati transitori, id casuale) e il nuovo metodo per il dettaglio notifica (dati reali) chiamano entrambi `renderMessage()`.

Nuovo endpoint in `NotificationsSearchController`: `GET /admin/notifications-search/:recipientId` → `NotificationsSearchService.getDetail(recipientId)`:
1. Carica `Recipient` con relazione `campaign` — 404 se non esiste.
2. Carica tutti i `NotificationAttempt` per quel `recipientId`, ordinati per `createdAt` (o `attemptNumber` se esiste — verificare campo esatto in entity durante l'implementazione).
3. Per ciascun attempt, espone: numero tentativo, stato, canale, `errorMessage`, `sentAt`, ed **esito App IO separato** se `responsePayload.appIo` presente (`{attempted: true, success, error?}` oppure `{attempted: false}`).
4. Chiama `CampaignsService.renderMessage(...)` con i dati reali del destinatario e il `channelConfig` della campagna, per ricostruire l'anteprima del messaggio realmente inviato (stesso motore usato dal wizard, garantendo che l'anteprima combaci col contenuto reale).
5. Ritorna `{ recipient, campaign: {name, channelType}, attempts: AttemptDetailDto[], preview: PreviewMessageResult }`.

### Frontend

Nessun modal riusabile esiste — nuovo componente modal minimale (markup Bootstrap standard: `modal fade show d-block` + backdrop, stesso stack CSS già caricato, nessuna nuova dipendenza).

In "Ricerca Notifiche" (`App.tsx:3828-3908`), ogni riga risultato (`:3878-3885`) diventa cliccabile (`onClick` + `cursor: pointer`), apre il modal che:
1. Fetcha `GET /notifications-search/:recipientId` al click.
2. Mostra: dati destinatario/campagna, timeline tentativi (icona per stato, canale, errore se presente), esito App IO separato se applicabile.
3. Mostra l'anteprima ricostruita (`preview.bodyHtml` via `dangerouslySetInnerHTML`, o `preview.bodyMarkdown` via `MDEditor.Markdown` — stessa logica già in uso nello Step 4 del wizard).

### Testing

- Unit test `getDetail()`: 404 se recipient non esiste; verifica shape della risposta con attempts multipli e con/senza co-consegna App IO.
- Unit test sul refactor di `renderMessage()`/`previewMessage()`: i test esistenti su `previewMessage()` devono continuare a passare invariati (refactor puramente interno, nessun cambio di contratto pubblico).
- Nessun test frontend runtime — verifica manuale nel browser dopo il deploy.

---

## Vincoli globali

- Nessuna migration DB nuova prevista **a meno che** la verifica cascade (Sezione 2) riveli che manca `ON DELETE CASCADE` nelle migration reali — in tal caso va aggiunta prima di procedere.
- Tutte e tre le route nuove seguono il prefisso `admin/` già in uso (`@Controller('admin/campaigns')`, `@Controller('admin/notifications-search')` — verificare il path esatto del controller esistente durante l'implementazione).
- `@Roles('admin')` per la sola route di cancellazione; le altre due (stats, dettaglio notifica) restano `user`+`admin` come il resto dei rispettivi controller.
- Nessuna nuova dipendenza npm (modal costruito con markup Bootstrap esistente).
