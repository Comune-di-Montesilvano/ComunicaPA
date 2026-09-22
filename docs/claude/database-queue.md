# Database & Query — Migration, Redis, TypeORM

## Migration DB

Dev: `synchronize` allinea lo schema automaticamente. Prod: le migration in `apps/backend/src/database/migrations/` girano da sole all'avvio (`migrationsRun` in `database.module.ts` — vanno anche registrate lì nell'array `migrations`). Dopo aver modificato un'entity, generare la migration con un DB temporaneo:

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_gen;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:generate src/database/migrations/NomeMigration -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_gen;"
```

**Bug reale — migration scritta ma non registrata è invisibile, nessun errore.** Una migration con solo `CREATE INDEX` raw (nessun `@Index` sull'entity) dimenticata nell'array `migrations` di `database.module.ts` non produce log né eccezioni: gli indici restano assenti sia in prod (mai eseguita) sia in dev (`synchronize` sincronizza solo i metadata delle entity, non SQL raw di una migration) — sintomo osservato solo indirettamente come lentezza su una query, non un errore. Dopo aver scritto una migration, verificare SEMPRE che la classe sia sia importata sia presente nell'array `migrations` (`grep NomeMigration database.module.ts`). Se serve testarla subito in dev senza aspettare un redeploy prod, applicare a mano l'SQL della migration sul DB dev (`docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "..."`, idempotente con `IF NOT EXISTS`).

**`repository.save({ id: 'stringa-fissa', ... })` su una colonna
`@PrimaryGeneratedColumn('uuid')` fallisce sempre** ("invalid input
syntax for type uuid") — se il chiamante è fail-open (try/catch che
logga solo un warn, pattern comune per un refresh/cache "meglio dati
vecchi che un crash"), l'errore sparisce silenziosamente e la tabella
resta vuota per sempre. Invisibile ai test se il repository è mockato
(il mock non valida i tipi). Se serve un record "singleton" riletto per
ultimo aggiornamento (es. una cache TSL/registro esterno), non forzare
un id fisso: lasciarlo autogenerato e leggere sempre `ORDER BY
<colonna-timestamp> DESC LIMIT 1`.

**Stessa cosa vale per una entity NUOVA**: va aggiunta sia all'array
`entities:` sia (se introduce una migration) all'array `migrations:` di
`database.module.ts` — mancare `entities:` fa fallire silenziosamente
l'injection del Repository per quella entity, nessun errore a compile-time.

## Redis — AOF obbligatorio (`--appendonly yes`), mai solo RDB di default per una coda BullMQ in produzione

`redis:7-alpine` di default fa solo snapshot RDB periodici (finestra
minima "60s/10000 scritture") — un container recreate (Portainer
"Recreate" sullo stack) tra due snapshot perde i job BullMQ accodati.
Incidente reale ripetuto due volte in una sessione (coda PEC svuotata,
poi un job di arricchimento). Fix: `command: redis-server --appendonly
yes` sul servizio in `docker-compose.yml` — persiste ogni scrittura.

## Migration enum Postgres — ALTER TYPE ADD VALUE

`typeorm migration:generate` NON sa generare `ALTER TYPE ... ADD VALUE` per un
nuovo valore enum Postgres: produce un diff invasivo (rename tipo esistente →
crea nuovo tipo → `ALTER COLUMN ... USING ... ::testo::nuovo_tipo` → drop/ricrea
eventuali FK coinvolte). Per aggiungere un valore enum, scrivi la migration a
mano con `ALTER TYPE "public"."<tabella>_status_enum" ADD VALUE '<valore>'`
(una query per tipo coinvolto), `down()` no-op documentato (Postgres non ha
`DROP VALUE`). Verifica eseguendo l'intera catena di migration su un DB
temporaneo pulito, non fidandoti dell'output grezzo del generatore.

## TypeORM v1 — select/relations vogliono forma oggetto, non più string[]

`FindOptionsSelect`/`FindOptionsRelations` in typeorm 1.x rifiutano
`select: ['a','b']`/`relations: ['a','b']` (`TS2559: no properties in
common`) — serve `select: { a: true, b: true }`. Bug reale: un mock di
test che leggeva `select.includes('campo')` per emulare la select va
riscritto come `select.campo` — non solo il codice prod, anche i mock
che leggono l'oggetto `select`/`relations` passato al repo.

## TypeORM — leftJoinAndSelect + orderBy + take, bug interno

TypeORM 0.3.30 lancia `Cannot read properties of undefined (reading
'databaseName')` in `createOrderByCombinedWithSelectExpression` quando
`take()`+`orderBy()` sono combinati con `leftJoinAndSelect()` su relazioni
dichiarate per stringa (`@ManyToOne('Campaign', ...)`, pattern usato in
tutte le entity di questo repo per evitare import circolari). Il bug è
silenzioso nei log di produzione (una riga di errore ogni tick cron, senza
stack trace) — un demone `@Cron` che lo colpisce non processa MAI nulla,
senza errori visibili all'avvio. Workaround: due query separate — la prima
(senza join) seleziona solo gli id con `where`/`orderBy`/`take`, la seconda
carica le relazioni via `Repository.find({ where: { id: In(ids) },
relations })`, senza `orderBy`/`take`. Vedi `protocollazione-sync.service.ts`
e `send-dispatch.service.ts`.

## Query paginata destinatari — subquery EXISTS va ancorata a recipient_id, non DISTINCT ON

`CampaignsService.getRecipientsPage()` faceva scansione full-table con
`DISTINCT ON` per calcolare l'ultimo tentativo per destinatario — su
campagne grandi (migliaia di righe) niente indice utile. Fix: subquery
`EXISTS` ancorata direttamente a `recipient_id` (scan indice, non
full-table), più indici dedicati (migration
`AddRecipientAndAttemptIndexes`): `recipients(campaign_id, status)` e
`notification_attempts(recipient_id, attempt_number, send_status,
postal_status, postal_delivery_status)`. Qualunque nuova query paginata
su `Recipient`/`NotificationAttempt` con filtro/ordinamento va verificata
con `EXPLAIN` per lo stesso pattern prima di aggiungerla, non assumere che
un indice esistente coincida per colonna d'ordine.

**`notification_attempts` non ha `updated_at`, solo `created_at`.** Una
query manuale/debug che assume anche un updated_at fallisce con
`column na.updated_at does not exist` (Postgres suggerisce da solo
`created_at`) — verificare sempre le colonne reali sull'entity prima di
scrivere SQL ad-hoc contro questa tabella.

**`download_events` — nessun indice su `recipient_id` di default.**
Qualunque query che filtra/aggrega per destinatario (combinazione canali
download, filtro "Canale download") degenera in scan completo della
tabella per riga senza indice — su campagne grandi (~19k destinatari)
sembra "il filtro si applica solo al poll successivo" quando in realtà è
solo lento oltre la finestra percepita come immediata.
`CREATE INDEX IF NOT EXISTS ON download_events(recipient_id)`.

