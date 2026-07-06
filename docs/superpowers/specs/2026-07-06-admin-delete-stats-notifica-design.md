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

## Sezione 4 — Tag canale sui link di download

### Stato attuale (scoperta durante il design)

Esistono **due meccanismi di tracking download completamente separati e incoerenti**:
- `PublicDownloadController` (link firmati email/PEC/App IO): incrementa `Recipient.downloadCount`/`firstDownloadedAt`/`lastDownloadedAt` (colonne dedicate).
- `CitizenService.markAsDownloaded` (portale cittadino, `POST /citizen/notifications/:id/download`): incrementa `recipient.extraData['download_count']`/`['downloaded_at']` — campi ad-hoc, mai letti da nessuna statistica lato admin.

Nessuno dei due registra **quale canale** ha generato il download. Il portale cittadino oggi non contribuisce affatto a nessuna statistica admin.

### Backend

Nuova entity `DownloadEvent` (`apps/backend/src/entities/download-event.entity.ts`): una riga per ogni download effettivo, qualunque canale — fonte di verità per le statistiche per canale, in aggiunta (non in sostituzione) ai contatori esistenti.

```ts
@Entity('download_events')
export class DownloadEvent {
  id: string (uuid, PK)
  recipientId: string
  channel: string  // 'EMAIL' | 'PEC' | 'APP_IO' | 'SEND' | 'POSTAL' | 'CITIZEN_PORTAL'
  attachmentIndex: number
  downloadedAt: Date (CreateDateColumn)
  recipient: Recipient (ManyToOne, onDelete CASCADE)
}
```

Migration nuova (unica di tutto il lavoro pianificato oggi) che crea la tabella + FK cascade, registrata in `database.module.ts`.

**Firma del link include il canale** (`download-link.util.ts`): `signDownloadLink`/`verifyDownloadLink` prendono un parametro opzionale `channel` incluso nell'HMAC, così il parametro `?ch=` nell'URL non è falsificabile lato client (un cittadino non può cambiarlo per "mentire" sulle statistiche).

`processTemplate()` prende un nuovo parametro opzionale `sourceChannel` (default `''`, retrocompatibile con tutte le chiamate/test esistenti che non lo passano) — lo inoltra alla generazione del link. Chi già chiama `processTemplate` per un invio reale (EmailStrategy, PecStrategy, co-consegna App IO in `notification.processor.ts`) passa il proprio canale reale.

`PublicDownloadController`: verifica il canale nella firma, in aggiunta all'update dei contatori esistenti inserisce una riga `DownloadEvent`.

`CitizenService.markAsDownloaded`: **unificato** — oltre al contatore `extraData` esistente (invariato, per non toccare il frontend cittadino), inserisce una riga `DownloadEvent` con `channel: 'CITIZEN_PORTAL'`.

Nuovo endpoint statistiche: `GET /admin/campaigns/:id/download-channel-stats` → `{campaignId, byChannel: Record<string, number>}` (conteggio download raggruppato per canale, via query su `DownloadEvent` joinata a `Recipient` filtrata per campagna).

Dettaglio notifica (Sezione 3): `NotificationDetailDto` guadagna un campo `downloads: Array<{channel: string; attachmentIndex: number; downloadedAt: string}>`.

### Frontend

- Dettaglio campagna: nuovo blocco "Download per Canale" (stesso stile del blocco breakdown multicanale della Sezione 1) con conteggio per canale.
- Modal dettaglio notifica (Sezione 3): nuova sezione elenco download (canale + data) per quel destinatario.

### Testing

- `download-link.util.spec.ts`: nuovi test per firma/verifica con canale, oltre ai test esistenti (che restano invariati, verificano il comportamento di default `channel=''`).
- `template.helper.spec.ts`: nuovo test che verifica la presenza di `&ch=EMAIL` nell'URL quando `sourceChannel` è passato; i test esistenti restano invariati (nessun `sourceChannel` passato → nessun `&ch=` nell'URL).
- `public-download.controller.spec.ts`: aggiornato per il nuovo parametro `ch` e l'inserimento del `DownloadEvent` (mock del nuovo repository).
- Nuovo `citizen.service.spec.ts` (non esisteva): verifica che `markAsDownloaded` inserisca un `DownloadEvent` con `channel: 'CITIZEN_PORTAL'` oltre ad aggiornare `extraData` come prima.
- Unit test su `getDownloadChannelStats()`.

## Vincoli globali

- Cascade DB già verificato presente (`ON DELETE CASCADE` confermato in `1783023440824-InitialSchema.ts`/`1783148719725-FixRecipientCampaignJoin.ts`) — nessuna migration necessaria per la Sezione 2. **Una migration nuova serve invece per la Sezione 4** (tabella `download_events`), l'unica del lavoro pianificato oggi.
- Tutte le route nuove seguono il prefisso `admin/` già in uso (`@Controller('admin/campaigns')`, `@Controller('admin/notifications-search')`).
- `@Roles('admin')` per la sola route di cancellazione; tutte le altre restano `user`+`admin` come il resto dei rispettivi controller.
- Nessuna nuova dipendenza npm (modal costruito con markup Bootstrap esistente).
