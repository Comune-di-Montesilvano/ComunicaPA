# Autorizzazione invio POSTAL + CRUD utenti abilitati — design

Data: 2026-09-14

## Obiettivo

Il canale POSTAL (raccomandate/lettere via GlobalCom) ha un costo reale per
spedizione. Oggi qualunque operatore con ruolo `user` può lanciare una
campagna POSTAL. Serve limitare chi può *avviare* un invio POSTAL a: sempre
gli `admin`, più un elenco di utenti `user` esplicitamente abilitati,
gestito da un pannello CRUD in Impostazioni.

## Perimetro (deciso in brainstorming)

- Il blocco copre **solo l'avvio** di un nuovo invio POSTAL: `launch()` e
  `launchTestSend()`. Retry singolo/bulk, correzione indirizzo+retry e
  content-correction su una campagna POSTAL già avviata da un utente
  autorizzato **restano permessi** a qualunque `user` (comportamento
  invariato) — non è nel perimetro di questa feature.
- Riguarda solo `channelType === 'POSTAL'` come canale primario. POSTAL non
  è mai un canale secondario/co-consegna (solo APP_IO lo è), quindi non c'è
  caso di "POSTAL nascosto dentro un'altra campagna" da considerare.
- Il pannello CRUD vive dentro la tab Impostazioni → Postalizzazione già
  esistente (`activeSettingsTab === 'postalizzazione'`,
  `renderPostalProvidersTab()` in `App.tsx`), non una tab nuova.
- Nel wizard campagne, l'opzione canale POSTAL viene disabilitata/nascosta
  per un `user` non autorizzato (mai far costruire una campagna che
  fallirebbe comunque al lancio) — gate UX, il vero controllo resta
  server-side in `launch()`/`launchTestSend()`.

## Modello dati

Nuova tabella dedicata, stesso pattern di `postal_provider_configs`
(tabella propria, non una chiave in `app_settings`, perché è un elenco di
righe con audit — non un blob di configurazione):

```ts
// apps/backend/src/entities/postal-authorized-user.entity.ts
@Entity('postal_authorized_users')
export class PostalAuthorizedUser {
  @PrimaryGeneratedColumn('uuid') id!: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  username!: string; // username LDAP/mock, stesso valore di JwtOperatorPayload.username

  @Column({ name: 'added_by', type: 'varchar', length: 255 })
  addedBy!: string; // username admin che ha aggiunto la riga

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
```

Nessun campo "ruolo": la presenza della riga = autorizzato. Un admin è
*sempre* autorizzato, indipendentemente dalla tabella (vedi logica sotto) —
la tabella serve solo per la lista di eccezioni tra gli `user`.

Migration `AddPostalAuthorizedUsersTable<timestamp>` (prossimo timestamp
libero dopo l'ultimo in `database.module.ts`, oggi
`AddPivaColumnsToInadVerificationJobs1786800000000` → usare
`1786900000000`), registrata sia nell'import sia nell'array `migrations`
(gotcha noto: una migration scritta ma non registrata è invisibile, nessun
errore).

## Backend

### Nuovo modulo `postal-authorized-users`

Stesso layout di `postal-providers/`:

- `postal-authorized-users.service.ts`:
  - `list(): Promise<Array<{ id, username, addedBy, addedByDisplayName, createdAt }>>`
    — risolve `addedByDisplayName` via `OperatorDirectoryService.resolveMany()`
    (stesso pattern usato per `createdByDisplayName` su Campaign).
  - `create(username: string, addedBy: string)`: trim, rifiuta stringa
    vuota (`BadRequestException`), verifica duplicato (constraint unique +
    messaggio leggibile invece del raw Postgres error, es. "Utente già
    abilitato"), insert.
  - `remove(id: string)`: `NotFoundException` se assente.
  - `isAuthorized(username: string): Promise<boolean>` — query singola
    `existsBy({ username })`. Usata sia da `CampaignsService` sia da
    `AuthService`/`AuthController` per calcolare `canUsePostal`.
- `postal-authorized-users.controller.ts` — `@Controller('admin/postal-authorized-users')`,
  tutti gli endpoint `@Roles('admin')` (a differenza di
  `postal-providers` non serve un GET aperto a `user`, la lista grezza non
  serve al wizard — al wizard basta il flag `canUsePostal` nel login):
  - `GET /` → `list()`
  - `POST /` (`{ username }`) → `create(username, req.user.username)`
  - `DELETE /:id` → `remove(id)`
- `postal-authorized-users.module.ts` — esporta `PostalAuthorizedUsersService`
  (va importato sia da `CampaignsModule` sia da `AuthModule`; ricordare
  `exports:` esplicito, gotcha già noto in CLAUDE.md quando un service
  guadagna un nuovo consumer esterno al modulo).

### Enforcement in `CampaignsService`

`launch()` oggi non riceve alcun `requester` — va aggiunto come nuovo
parametro (breaking change di firma, quindi **audit obbligatorio** di ogni
`Test.createTestingModule`/chiamata diretta esistente, stesso principio già
documentato in CLAUDE.md per cambi di firma):

```ts
async launch(
  campaignId: string,
  requester: CampaignRequester,
): Promise<{ launched: number; campaignId: string; blocked?: boolean; message?: string }>
```

Subito dopo aver caricato `campaign` (prima di qualunque altro controllo
bloccante, stesso punto dove oggi vive `checkAttachmentsBlocking`):

```ts
if (campaign.channelType === 'POSTAL' && requester.role !== 'admin') {
  const authorized = await this.postalAuthorizedUsers.isAuthorized(requester.username);
  if (!authorized) {
    await this.campaignRepo.update({ id: campaignId }, { status: CampaignStatus.DRAFT });
    return {
      launched: 0,
      campaignId,
      blocked: true,
      message: 'Non sei autorizzato ad avviare invii Postalizzazione. Contatta un amministratore.',
    };
  }
}
```

Stesso identico blocco (stesso messaggio) in `launchTestSend()`, prima di
creare il child/il singolo attempt di test. **Mai** `ForbiddenException`/
altra eccezione non-2xx qui — stesso motivo già documentato per
`checkAttachmentsBlocking` (reverse proxy esterno sostituisce il body delle
risposte non-2xx con una pagina HTML, messaggio illeggibile lato UI).

`CampaignsController`: gli endpoint `POST :id/launch` e `POST :id/test-send`
passano già `req.user` — basta costruire
`{ username: req.user.username, role: req.user.role }` e passarlo alle
chiamate service (nessun nuovo dato da leggere).

### `canUsePostal` in login/me

`AuthResponseDto` guadagna un campo:

```ts
canUsePostal!: boolean;
```

Calcolato in `AuthService.loginWithLdap()`:
`ldapUser.role === 'admin' || await this.postalAuthorizedUsers.isAuthorized(ldapUser.username)`.

Non tocchiamo `JwtOperatorPayload` (il JWT resta invariato, il claim non
serve lato backend per validare — l'unico controllo reale che conta è
quello server-side in `launch()`/`launchTestSend()`, sempre ricalcolato
dal DB). `canUsePostal` è solo per la UX del wizard, quindi basta nella
risposta di login — stesso principio già in vigore per `role` (letto una
volta al login, non ri-verificato ad ogni render). Se l'allowlist cambia
dopo il login, l'operatore vede il flag aggiornato al prossimo login — non
un problema di sicurezza (il gate reale è server-side), solo di
freschezza UX, stesso trade-off già accettato per `role`.

## Frontend (`frontend-admin`)

### Stato e login

- `App.tsx`: nuovo state `const [canUsePostal, setCanUsePostal] = useState<boolean>(...)`
  inizializzato da `localStorage.getItem('comunicapa_can_use_postal') === 'true'`,
  salvato/aggiornato nello stesso blocco dove oggi si gestisce `data.role`
  al login (`localStorage.setItem('comunicapa_can_use_postal', String(data.canUsePostal))`).

### Pannello CRUD (Impostazioni → Postalizzazione)

Dentro `renderPostalProvidersTab()`, nuova sezione (card) "Utenti abilitati
all'invio Postalizzazione", sotto l'elenco provider esistente:

- Tabella: colonna Utente, Aggiunto da, Data, azione Rimuovi (icona
  `Trash2` già nel registro icone del file, stesso pattern liste esistenti
  in Impostazioni).
- Input testo + bottone "Aggiungi" (username libero, validazione minima
  client-side: non vuoto) — **non** un `<form>` proprio, stesso vincolo
  già documentato in CLAUDE.md (Impostazioni è già dentro un unico
  `<form onSubmit={handleSaveSettings}>`): usare `<div>` + `onClick`
  esplicito sul bottone Aggiungi.
- Fetch dedicato (`fetchPostalAuthorizedUsers()`) chiamato all'apertura
  della tab Postalizzazione (stesso pattern già in uso per i provider) —
  non serve polling (lista amministrativa, non stato "in corso").
- Errori (es. duplicato) mostrati con lo stesso pattern toast/alert già
  usato per gli altri pannelli CRUD di Impostazioni.

### Gate nel wizard

Dove il wizard espone la scelta canale (bottoni/select `wizChannel`),
l'opzione `POSTAL` viene disabilitata quando `role !== 'admin' &&
!canUsePostal`, con tooltip "Richiede autorizzazione — contatta un
amministratore". Se l'operatore ha già una bozza esistente con
`channelType: 'POSTAL'` salvata prima di perdere l'autorizzazione (caso
limite: admin rimuove l'utente dalla lista dopo che questi ha già creato
una bozza), il wizard non blocca la ripresa/editing della bozza — solo la
*selezione* di un nuovo canale POSTAL da zero; il blocco reale resta
comunque `launch()` lato server, che intercetterebbe questo caso limite.

## Test

- `postal-authorized-users.service.spec.ts`: CRUD, duplicato rifiutato,
  `isAuthorized()` true/false.
- `campaigns.service.spec.ts`: nuovo branch in `launch()` —
  admin sempre passa; `user` non in lista → `blocked:true` + campagna
  riportata a `DRAFT`; `user` in lista → passa. Stesso branch replicato per
  `launchTestSend()`.
- Grep `createTestingModule`/istanziazioni dirette di `CampaignsService` e
  di ogni test che chiama `.launch(` con la vecchia firma (un solo
  argomento) — aggiornare tutte le chiamate con il nuovo parametro
  `requester`, verificare con la suite completa (non un pattern mirato),
  stesso principio già in CLAUDE.md per cambi di firma.
- `auth.service.spec.ts`: `loginWithLdap()` include `canUsePostal` corretto
  per admin/user-autorizzato/user-non-autorizzato.

## Fuori perimetro (non in questa feature)

- Retry/resend su campagne POSTAL già avviate (deciso in brainstorming).
- Generalizzare l'allowlist ad altri canali (SEND, ecc.) — non richiesto,
  YAGNI; se servirà in futuro, la tabella può guadagnare una colonna
  `channel` senza rompere niente di questa versione.
- Audit log dedicato per aggiunte/rimozioni dalla lista (il CRUD è già
  admin-only e la colonna `addedBy` ne resta traccia in DB; se serve un
  log strutturato come `AuditLogsService`, va richiesto esplicitamente).
