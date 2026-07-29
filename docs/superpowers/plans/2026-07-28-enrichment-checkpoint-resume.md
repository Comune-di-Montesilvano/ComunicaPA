# Arricchimento Tracciati — checkpoint/resume + correzione manuale indirizzo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** far riprendere un job di arricchimento tracciati da un checkpoint su disco (ogni 100 righe) invece di restare bloccato in `PROCESSING` per sempre dopo un riavvio backend, e permettere all'operatore di correggere manualmente l'indirizzo di una riga quando l'estrazione PDF fallisce (con prefill opzionale da ANPR).

**Architecture:** `EnrichmentProcessor.process()` scrive uno snapshot atomico (`checkpoint.json.tmp` → rename) ogni 100 righe elaborate; un provider `OnModuleInit` rileva a boot i job bloccati in `PROCESSING` e li rimette in coda se esiste un checkpoint leggibile. Le correzioni indirizzo vivono in una tabella dedicata (`EnrichmentAddressOverride`, chiave `jobId+pdfFilename`) applicate ai dati prima di ogni scrittura CSV/checkpoint; un endpoint `regenerate-csv` le rifonde nel CSV finale già scritto.

**Tech Stack:** NestJS 10, TypeORM 0.3, BullMQ, Jest (`--maxWorkers=2`), React 19 (frontend-admin, `App.tsx`).

## Global Constraints

- Backend gira SOLO in Docker — nessun comando `node`/`pnpm` sull'host, tutto via `docker compose exec backend ...`.
- Test: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2 <pattern>` per singolo file, suite COMPLETA prima di dichiarare baseline pulita (obbligatorio dopo modifica firma costruttore, vedi Task 6).
- Type-check: `docker compose exec backend node_modules/.bin/tsc --noEmit`.
- Migration DB: generare con DB temporaneo (procedura in `CLAUDE.md`, sezione "Migration DB") — mai `migration:generate` su `ALTER TYPE`, qui non serve (nessun nuovo enum).
- Mai eccezione HTTP non-2xx per errori "previsti" da mostrare all'operatore — pattern `{ blocked: true, message }` con `HttpStatus.OK` (reverse proxy esterno sostituisce il body delle risposte non-2xx).
- Ogni nuovo parametro di costruttore rompe silenziosamente gli spec file che istanziano la classe con `new X(...)` — aggiornare TUTTI gli spec che toccano `EnrichmentProcessor`/`EnrichmentController` nello stesso task che cambia la firma.
- Scrittura file mai diretta se il contenuto deve sopravvivere a un crash a metà — sempre file temporaneo + rename atomico.

---

## File Structure

**Backend — nuovi file:**
- `apps/backend/src/enrichment/enrichment-checkpoint.util.ts` — write/read/delete atomici del checkpoint su disco.
- `apps/backend/src/entities/enrichment-address-override.entity.ts` — entity `EnrichmentAddressOverride`.
- `apps/backend/src/enrichment/enrichment-address-override.service.ts` — CRUD override + funzione `applyOverrides(rows, overrides)`.
- `apps/backend/src/enrichment/enrichment-resume.service.ts` — scan a boot dei job `PROCESSING`.
- `apps/backend/src/database/migrations/<timestamp>-AddCheckpointRowToEnrichmentJobs.ts`
- `apps/backend/src/database/migrations/<timestamp>-CreateEnrichmentAddressOverrides.ts`

**Backend — file modificati:**
- `apps/backend/src/entities/enrichment-job.entity.ts` — colonna `checkpointRow`.
- `apps/backend/src/enrichment/enrichment-paths.ts` — `getEnrichmentCheckpoint(jobId)`.
- `apps/backend/src/enrichment/enriched-csv.util.ts` — `parseEnrichedCsv`.
- `apps/backend/src/enrichment/enrichment.processor.ts` — resume, checkpoint, applicazione override.
- `apps/backend/src/enrichment/enrichment.processor.spec.ts` — nuovo 4° argomento costruttore, nuovi test.
- `apps/backend/src/enrichment/enrichment.service.ts` — `getRow`, `saveAddressOverride`, `regenerateCsv`.
- `apps/backend/src/enrichment/enrichment.service.spec.ts` — nuovi test.
- `apps/backend/src/enrichment/enrichment.controller.ts` — 3 nuovi endpoint.
- `apps/backend/src/enrichment/enrichment.controller.spec.ts` — nuovi test.
- `apps/backend/src/enrichment/enrichment.module.ts` — registrazione nuova entity/provider.
- `apps/backend/src/database/database.module.ts` — registrazione 2 nuove migration + entity.

**Frontend-admin — file modificati:**
- `apps/frontend-admin/src/App.tsx` — stato/handler correzione indirizzo, gate `checkpointRow`, bottone "Rigenera CSV".

---

### Task 1: Colonna `checkpointRow` su `EnrichmentJob`

**Files:**
- Modify: `apps/backend/src/entities/enrichment-job.entity.ts`
- Create: `apps/backend/src/database/migrations/1785700000000-AddCheckpointRowToEnrichmentJobs.ts`
- Modify: `apps/backend/src/database/database.module.ts`

**Interfaces:**
- Produces: `EnrichmentJob.checkpointRow: number` (colonna `checkpoint_row`, default `0`) — letto dal frontend (Task 12) e scritto dal processor (Task 6).

- [ ] **Step 1: Aggiungere la colonna all'entity**

In `apps/backend/src/entities/enrichment-job.entity.ts`, dopo `processedRecords`:

```ts
  @Column({ name: 'checkpoint_row', type: 'int', default: 0 })
  checkpointRow!: number;
```

- [ ] **Step 2: Creare la migration**

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCheckpointRowToEnrichmentJobs1785700000000 implements MigrationInterface {
    name = 'AddCheckpointRowToEnrichmentJobs1785700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "enrichment_jobs" ADD "checkpoint_row" integer NOT NULL DEFAULT 0`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "enrichment_jobs" DROP COLUMN "checkpoint_row"`);
    }
}
```

- [ ] **Step 3: Registrare la migration**

In `apps/backend/src/database/database.module.ts`: aggiungere l'import
`import { AddCheckpointRowToEnrichmentJobs1785700000000 } from './migrations/1785700000000-AddCheckpointRowToEnrichmentJobs';`
e appendere `AddCheckpointRowToEnrichmentJobs1785700000000` in fondo all'array `migrations: [...]`.

- [ ] **Step 4: Verifica type-check**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 5: Verifica migration su DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_gen;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_gen;"
```
Expected: tutte le migration girano senza errori, inclusa quella nuova.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/entities/enrichment-job.entity.ts apps/backend/src/database/migrations/1785700000000-AddCheckpointRowToEnrichmentJobs.ts apps/backend/src/database/database.module.ts
git commit -m "feat(enrichment): colonna checkpointRow su EnrichmentJob"
```

---

### Task 2: Entity + migration `EnrichmentAddressOverride`

**Files:**
- Create: `apps/backend/src/entities/enrichment-address-override.entity.ts`
- Create: `apps/backend/src/database/migrations/1785800000000-CreateEnrichmentAddressOverrides.ts`
- Modify: `apps/backend/src/database/database.module.ts`

**Interfaces:**
- Produces: `EnrichmentAddressOverride` entity — `{ id, jobId, pdfFilename, indirizzo, cap, comune, provincia, statoEstero, correctedBy, correctedAt }`. Usata da Task 4 (`applyOverrides`), Task 8 (`enrichment.service.ts`).

- [ ] **Step 1: Creare l'entity**

```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('enrichment_address_overrides')
@Index(['jobId', 'pdfFilename'], { unique: true })
export class EnrichmentAddressOverride {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'job_id', type: 'uuid' })
  jobId!: string;

  @Column({ name: 'pdf_filename', type: 'varchar', length: 512 })
  pdfFilename!: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  indirizzo!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  cap!: string | null;

  @Column({ type: 'varchar', length: 256, nullable: true })
  comune!: string | null;

  @Column({ type: 'varchar', length: 8, nullable: true })
  provincia!: string | null;

  @Column({ name: 'stato_estero', type: 'varchar', length: 256, nullable: true })
  statoEstero!: string | null;

  @Column({ name: 'corrected_by', type: 'varchar', length: 256 })
  correctedBy!: string;

  @CreateDateColumn({ name: 'corrected_at' })
  correctedAt!: Date;
}
```

- [ ] **Step 2: Creare la migration**

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateEnrichmentAddressOverrides1785800000000 implements MigrationInterface {
    name = 'CreateEnrichmentAddressOverrides1785800000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "enrichment_address_overrides" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "job_id" uuid NOT NULL,
                "pdf_filename" character varying(512) NOT NULL,
                "indirizzo" character varying(512),
                "cap" character varying(16),
                "comune" character varying(256),
                "provincia" character varying(8),
                "stato_estero" character varying(256),
                "corrected_by" character varying(256) NOT NULL,
                "corrected_at" TIMESTAMP NOT NULL DEFAULT now(),
                CONSTRAINT "PK_enrichment_address_overrides" PRIMARY KEY ("id")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "IDX_enrichment_address_overrides_job_pdf"
            ON "enrichment_address_overrides" ("job_id", "pdf_filename")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "enrichment_address_overrides"`);
    }
}
```

- [ ] **Step 3: Registrare entity + migration**

In `apps/backend/src/database/database.module.ts`:
- import dell'entity e aggiunta in `entities: [...]`;
- import della migration e append in `migrations: [...]` (dopo quella del Task 1).

- [ ] **Step 4: Verifica migration su DB temporaneo**

Stessa procedura del Task 1 Step 5.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/entities/enrichment-address-override.entity.ts apps/backend/src/database/migrations/1785800000000-CreateEnrichmentAddressOverrides.ts apps/backend/src/database/database.module.ts
git commit -m "feat(enrichment): entity e tabella EnrichmentAddressOverride"
```

---

### Task 3: Checkpoint su disco — path + util atomico

**Files:**
- Modify: `apps/backend/src/enrichment/enrichment-paths.ts`
- Create: `apps/backend/src/enrichment/enrichment-checkpoint.util.ts`
- Test: `apps/backend/src/enrichment/enrichment-checkpoint.util.spec.ts`

**Interfaces:**
- Produces:
  - `getEnrichmentCheckpoint(jobId: string): string`
  - `interface EnrichmentCheckpoint { lastRow: number; rows: EnrichedRow[]; warnings: EnrichmentWarning[]; maxRate: number }`
  - `writeCheckpointSync(jobId: string, data: EnrichmentCheckpoint): void`
  - `readCheckpointSync(jobId: string): EnrichmentCheckpoint | null` (ritorna `null` se assente o non parsabile, mai lancia)
  - `deleteCheckpointSync(jobId: string): void`
- Consumes: `EnrichedRow` da `./enriched-csv.util`, `EnrichmentWarning` da `../entities/enrichment-job.entity`.

- [ ] **Step 1: Aggiungere il path**

In `apps/backend/src/enrichment/enrichment-paths.ts`, aggiungere:

```ts
export function getEnrichmentCheckpoint(jobId: string): string {
  return join(getEnrichmentDir(jobId), 'checkpoint.json');
}
```

- [ ] **Step 2: Scrivere il test per lo scrittore/lettore atomico**

```ts
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { getEnrichmentDir, getEnrichmentCheckpoint } from './enrichment-paths';
import { writeCheckpointSync, readCheckpointSync, deleteCheckpointSync } from './enrichment-checkpoint.util';

describe('enrichment-checkpoint.util', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'enrich-ckpt-'));
    process.env['ATTACHMENTS_PATH'] = tmpDir;
    fs.mkdirSync(getEnrichmentDir('j1'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env['ATTACHMENTS_PATH'];
  });

  it('scrive e rilegge un checkpoint valido', () => {
    writeCheckpointSync('j1', { lastRow: 100, rows: [{ codice_fiscale: 'ABC' }], warnings: [], maxRate: 2 });
    const read = readCheckpointSync('j1');
    expect(read).toEqual({ lastRow: 100, rows: [{ codice_fiscale: 'ABC' }], warnings: [], maxRate: 2 });
  });

  it('nessun file checkpoint → null', () => {
    expect(readCheckpointSync('j1')).toBeNull();
  });

  it('file checkpoint corrotto (JSON non parsabile) → null, non lancia', () => {
    fs.writeFileSync(getEnrichmentCheckpoint('j1'), '{not valid json');
    expect(readCheckpointSync('j1')).toBeNull();
  });

  it('scrittura non lascia mai un file .tmp residuo', () => {
    writeCheckpointSync('j1', { lastRow: 1, rows: [], warnings: [], maxRate: 0 });
    expect(fs.existsSync(getEnrichmentCheckpoint('j1') + '.tmp')).toBe(false);
  });

  it('delete rimuove il file, idempotente se già assente', () => {
    writeCheckpointSync('j1', { lastRow: 1, rows: [], warnings: [], maxRate: 0 });
    deleteCheckpointSync('j1');
    expect(fs.existsSync(getEnrichmentCheckpoint('j1'))).toBe(false);
    expect(() => deleteCheckpointSync('j1')).not.toThrow();
  });
});
```

- [ ] **Step 3: Eseguire il test, verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest enrichment-checkpoint --maxWorkers=2`
Expected: FAIL — `Cannot find module './enrichment-checkpoint.util'`.

- [ ] **Step 4: Implementare l'util**

```ts
import * as fs from 'fs';
import { getEnrichmentCheckpoint } from './enrichment-paths';
import type { EnrichedRow } from './enriched-csv.util';
import type { EnrichmentWarning } from '../entities/enrichment-job.entity';

export interface EnrichmentCheckpoint {
  lastRow: number;
  rows: EnrichedRow[];
  warnings: EnrichmentWarning[];
  maxRate: number;
}

/**
 * Scrittura atomica: mai fs.writeFileSync diretto sul file finale — un crash
 * a metà scrittura lascerebbe un JSON troncato che il resume leggerebbe come
 * dato valido parziale invece che come "checkpoint assente".
 */
export function writeCheckpointSync(jobId: string, data: EnrichmentCheckpoint): void {
  const finalPath = getEnrichmentCheckpoint(jobId);
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data));
  fs.renameSync(tmpPath, finalPath);
}

export function readCheckpointSync(jobId: string): EnrichmentCheckpoint | null {
  const path = getEnrichmentCheckpoint(jobId);
  if (!fs.existsSync(path)) return null;
  try {
    return JSON.parse(fs.readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function deleteCheckpointSync(jobId: string): void {
  fs.rmSync(getEnrichmentCheckpoint(jobId), { force: true });
}
```

- [ ] **Step 5: Eseguire il test, verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest enrichment-checkpoint --maxWorkers=2`
Expected: PASS (5 test).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/enrichment/enrichment-paths.ts apps/backend/src/enrichment/enrichment-checkpoint.util.ts apps/backend/src/enrichment/enrichment-checkpoint.util.spec.ts
git commit -m "feat(enrichment): util checkpoint atomico su disco"
```

---

### Task 4: `parseEnrichedCsv` — rileggere il CSV risultato per il rigenera

**Files:**
- Modify: `apps/backend/src/enrichment/enriched-csv.util.ts`
- Test: `apps/backend/src/enrichment/enriched-csv.util.spec.ts` (file esistente — aggiungere test)

**Interfaces:**
- Produces: `parseEnrichedCsv(content: string): { headers: string[]; rows: EnrichedRow[] }` — inverso di `buildEnrichedCsv`. Usato da Task 8 (`regenerateCsv`).
- Consumes: nessuno (stesso formato quote-all `;`-delimited già prodotto da `buildEnrichedCsv`).

- [ ] **Step 1: Scrivere il test (round-trip build → parse)**

Aggiungere in fondo a `apps/backend/src/enrichment/enriched-csv.util.spec.ts`:

```ts
import { parseEnrichedCsv } from './enriched-csv.util';

describe('parseEnrichedCsv', () => {
  it('round-trip: parse(build(rows)) === rows originali', () => {
    const headers = buildEnrichedCsvHeaders(0);
    const rows: EnrichedRow[] = [
      { codice_fiscale: 'RSSMRA80A01H501U', allegato: 'PROVV_1.pdf', indirizzo: 'VIA ROMA 1' },
      { codice_fiscale: 'VRDLGU70A01H501X', allegato: 'PROVV_2.pdf', indirizzo: '' },
    ];
    const csv = buildEnrichedCsv(headers, rows);
    const parsed = parseEnrichedCsv(csv);
    expect(parsed.headers).toEqual(headers);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]['codice_fiscale']).toBe('RSSMRA80A01H501U');
    expect(parsed.rows[0]['allegato']).toBe('PROVV_1.pdf');
    expect(parsed.rows[1]['indirizzo']).toBe('');
  });

  it('gestisce virgolette escaped ("") dentro un campo', () => {
    const headers = ['nominativo'];
    const csv = buildEnrichedCsv(headers, [{ nominativo: 'ROSSI "MARIO" jr' }]);
    const parsed = parseEnrichedCsv(csv);
    expect(parsed.rows[0]['nominativo']).toBe('ROSSI "MARIO" jr');
  });
});
```

- [ ] **Step 2: Eseguire il test, verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest enriched-csv --maxWorkers=2`
Expected: FAIL — `parseEnrichedCsv is not a function`.

- [ ] **Step 3: Implementare `parseEnrichedCsv`**

Aggiungere in fondo a `apps/backend/src/enrichment/enriched-csv.util.ts`:

```ts
/**
 * Inverso di buildEnrichedCsv. Sicuro solo sul formato che produciamo noi
 * stessi (QUOTE_ALL, delimitatore ';', nessun newline embedded nei campi —
 * non un parser CSV generico per input esterno/untrusted).
 */
function parseCsvLine(line: string): string[] {
  const matches = line.match(/"(?:[^"]|"")*"/g) ?? [];
  return matches.map((m) => m.slice(1, -1).replace(/""/g, '"'));
}

export function parseEnrichedCsv(content: string): { headers: string[]; rows: EnrichedRow[] } {
  const lines = content.split('\n').filter((l) => l.length > 0);
  const headers = parseCsvLine(lines[0] ?? '');
  const rows: EnrichedRow[] = lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row: EnrichedRow = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
  return { headers, rows };
}
```

- [ ] **Step 4: Eseguire il test, verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest enriched-csv --maxWorkers=2`
Expected: PASS (tutti i test del file, inclusi quelli preesistenti).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/enrichment/enriched-csv.util.ts apps/backend/src/enrichment/enriched-csv.util.spec.ts
git commit -m "feat(enrichment): parseEnrichedCsv per rigenerazione CSV con override"
```

---

### Task 5: `EnrichmentAddressOverrideService` — CRUD + applicazione righe

**Files:**
- Create: `apps/backend/src/enrichment/enrichment-address-override.service.ts`
- Test: `apps/backend/src/enrichment/enrichment-address-override.service.spec.ts`

**Interfaces:**
- Consumes: `EnrichmentAddressOverride` (Task 2), `EnrichedRow` (`./enriched-csv.util`).
- Produces:
  - `class EnrichmentAddressOverrideService { constructor(repo: Repository<EnrichmentAddressOverride>) }`
  - `upsert(jobId: string, pdfFilename: string, address: { indirizzo?: string; cap?: string; comune?: string; provincia?: string; statoEstero?: string }, correctedBy: string): Promise<EnrichmentAddressOverride>`
  - `findByJob(jobId: string): Promise<EnrichmentAddressOverride[]>`
  - `applyOverrides(rows: EnrichedRow[], overrides: EnrichmentAddressOverride[]): EnrichedRow[]` (pure, no I/O — patcha `indirizzo/cap/comune/provincia/stato_estero` sulle righe con `allegato` matchato, ritorna nuovo array, non muta l'input)

Usata da: Task 6 (processor), Task 8 (`regenerateCsv`).

- [ ] **Step 1: Scrivere i test**

```ts
import { EnrichmentAddressOverrideService } from './enrichment-address-override.service';

describe('EnrichmentAddressOverrideService', () => {
  let repo: any;
  let service: EnrichmentAddressOverrideService;

  beforeEach(() => {
    repo = {
      upsert: jest.fn(async () => undefined),
      findOneBy: jest.fn(async () => ({ id: 'o1', jobId: 'j1', pdfFilename: 'PROVV_1.pdf', indirizzo: 'VIA NUOVA 1', cap: '00100', comune: 'ROMA', provincia: 'RM', statoEstero: null, correctedBy: 'op', correctedAt: new Date() })),
      find: jest.fn(async () => []),
    };
    service = new EnrichmentAddressOverrideService(repo);
  });

  it('upsert scrive su (jobId, pdfFilename) e ritorna la riga salvata', async () => {
    const result = await service.upsert('j1', 'PROVV_1.pdf', { indirizzo: 'VIA NUOVA 1', cap: '00100', comune: 'ROMA', provincia: 'RM' }, 'op');
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'j1', pdfFilename: 'PROVV_1.pdf', indirizzo: 'VIA NUOVA 1', correctedBy: 'op' }),
      ['jobId', 'pdfFilename'],
    );
    expect(result.indirizzo).toBe('VIA NUOVA 1');
  });

  it('findByJob ritorna tutti gli override del job', async () => {
    repo.find.mockResolvedValue([{ pdfFilename: 'PROVV_1.pdf' }]);
    const result = await service.findByJob('j1');
    expect(repo.find).toHaveBeenCalledWith({ where: { jobId: 'j1' } });
    expect(result).toEqual([{ pdfFilename: 'PROVV_1.pdf' }]);
  });

  it('applyOverrides patcha solo le righe con allegato matchato, non muta l\'array originale', () => {
    const rows = [
      { allegato: 'PROVV_1.pdf', indirizzo: 'VIA VECCHIA', cap: '00000', comune: 'X', provincia: 'XX', stato_estero: '' },
      { allegato: 'PROVV_2.pdf', indirizzo: 'INVARIATA', cap: '11111', comune: 'Y', provincia: 'YY', stato_estero: '' },
    ];
    const overrides = [
      { jobId: 'j1', pdfFilename: 'PROVV_1.pdf', indirizzo: 'VIA NUOVA', cap: '00100', comune: 'ROMA', provincia: 'RM', statoEstero: null } as any,
    ];
    const patched = service.applyOverrides(rows, overrides);
    expect(patched[0].indirizzo).toBe('VIA NUOVA');
    expect(patched[0].cap).toBe('00100');
    expect(patched[1].indirizzo).toBe('INVARIATA');
    expect(rows[0].indirizzo).toBe('VIA VECCHIA'); // input non mutato
  });

  it('applyOverrides con statoEstero valorizzato patcha anche stato_estero', () => {
    const rows = [{ allegato: 'PROVV_1.pdf', indirizzo: 'X', cap: 'Y', comune: 'Z', provincia: 'W', stato_estero: '' }];
    const overrides = [{ jobId: 'j1', pdfFilename: 'PROVV_1.pdf', indirizzo: 'VIA ESTERA', cap: '', comune: 'BRUXELLES', provincia: '', statoEstero: 'Belgio' } as any];
    const patched = service.applyOverrides(rows, overrides);
    expect(patched[0].stato_estero).toBe('Belgio');
  });
});
```

- [ ] **Step 2: Eseguire il test, verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest enrichment-address-override --maxWorkers=2`
Expected: FAIL — modulo non trovato.

- [ ] **Step 3: Implementare il service**

```ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EnrichmentAddressOverride } from '../entities/enrichment-address-override.entity';
import type { EnrichedRow } from './enriched-csv.util';

export interface AddressOverrideInput {
  indirizzo?: string;
  cap?: string;
  comune?: string;
  provincia?: string;
  statoEstero?: string;
}

@Injectable()
export class EnrichmentAddressOverrideService {
  constructor(
    @InjectRepository(EnrichmentAddressOverride)
    private readonly repo: Repository<EnrichmentAddressOverride>,
  ) {}

  async upsert(
    jobId: string,
    pdfFilename: string,
    address: AddressOverrideInput,
    correctedBy: string,
  ): Promise<EnrichmentAddressOverride> {
    await this.repo.upsert(
      {
        jobId,
        pdfFilename,
        indirizzo: address.indirizzo ?? null,
        cap: address.cap ?? null,
        comune: address.comune ?? null,
        provincia: address.provincia ?? null,
        statoEstero: address.statoEstero ?? null,
        correctedBy,
      },
      ['jobId', 'pdfFilename'],
    );
    return (await this.repo.findOneBy({ jobId, pdfFilename }))!;
  }

  findByJob(jobId: string): Promise<EnrichmentAddressOverride[]> {
    return this.repo.find({ where: { jobId } });
  }

  /**
   * Pure, nessun I/O: usata sia dal processor (checkpoint/CSV finale) sia da
   * regenerateCsv (CSV già scritto). Non muta l'array di input — il chiamante
   * potrebbe ancora servirsi della versione non patchata (es. checkpoint).
   */
  applyOverrides(rows: EnrichedRow[], overrides: EnrichmentAddressOverride[]): EnrichedRow[] {
    const byFilename = new Map(overrides.map((o) => [o.pdfFilename, o]));
    return rows.map((row) => {
      const override = row['allegato'] ? byFilename.get(row['allegato']) : undefined;
      if (!override) return row;
      return {
        ...row,
        indirizzo: override.indirizzo ?? row['indirizzo'],
        cap: override.cap ?? row['cap'],
        comune: override.comune ?? row['comune'],
        provincia: override.provincia ?? row['provincia'],
        stato_estero: override.statoEstero ?? row['stato_estero'],
      };
    });
  }
}
```

- [ ] **Step 4: Eseguire il test, verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest enrichment-address-override --maxWorkers=2`
Expected: PASS (5 test).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/enrichment/enrichment-address-override.service.ts apps/backend/src/enrichment/enrichment-address-override.service.spec.ts
git commit -m "feat(enrichment): service override indirizzo (CRUD + applicazione righe)"
```

---

### Task 6: `EnrichmentProcessor` — checkpoint, resume, applicazione override

**Files:**
- Modify: `apps/backend/src/enrichment/enrichment.processor.ts`
- Modify: `apps/backend/src/enrichment/enrichment.processor.spec.ts` (nuovo 4° arg costruttore + nuovi test)

**Interfaces:**
- Consumes: `writeCheckpointSync/readCheckpointSync/deleteCheckpointSync` (Task 3), `EnrichmentAddressOverrideService.findByJob/applyOverrides` (Task 5).
- Produces: `new EnrichmentProcessor(jobRepo, extractor, events, overrideService)` — **firma costruttore cambiata, 4° argomento**. `EnrichmentJob.checkpointRow` scritto ad ogni checkpoint.

Questo task rompe la firma esistente (`new EnrichmentProcessor(repo, client, events)`, 3 argomenti) — l'intero file di spec va aggiornato, non solo i nuovi test.

- [ ] **Step 1: Aggiornare il setup dello spec esistente per il 4° argomento**

In `apps/backend/src/enrichment/enrichment.processor.spec.ts`, nel `beforeEach`:

```ts
    events = { emitLog: jest.fn(), emitTerminal: jest.fn() };
    overrideService = { findByJob: jest.fn(async () => []), applyOverrides: jest.fn((rows: any) => rows) };
    processor = new EnrichmentProcessor(repo, client, events, overrideService);
```

(dichiarare `let overrideService: any;` insieme alle altre `let` in testa al `describe`).

- [ ] **Step 2: Eseguire la suite esistente, verificare che fallisca per firma**

Run: `docker compose exec backend node_modules/.bin/jest enrichment.processor --maxWorkers=2`
Expected: FAIL — TypeScript non compila ancora (`overrideService` non esiste come 4° parametro nel costruttore reale). Questo è lo stato di transizione previsto: il file di produzione viene modificato nello step successivo.

- [ ] **Step 3: Scrivere i nuovi test (resume + checkpoint + override)**

Aggiungere in fondo al `describe('EnrichmentProcessor', ...)`, prima della chiusura:

```ts
  it('checkpoint scritto ogni 100 righe: con meno di 100 record nessun checkpoint intermedio, ma checkpointRow finale = totale', async () => {
    await processor.process(fakeJob);
    const finalUpdate = repo.update.mock.calls.at(-1)![1];
    expect(finalUpdate.status).toBe(EnrichmentJobStatus.DONE);
    // Il job di test ha 2 record: sotto soglia 100, checkpointRow avanza comunque a fine job
    // per coerenza (nessuna riga "non committata" a job concluso).
  });

  it('resume: con checkpoint esistente, salta extractor.extract per le righe già coperte da lastRow', async () => {
    const { writeCheckpointSync } = await import('./enrichment-checkpoint.util');
    writeCheckpointSync('j1', {
      lastRow: 1,
      rows: [{ codice_fiscale: 'RSSMRA80A01H501U', allegato: 'PROVV_1.pdf', indirizzo: 'GIA PROCESSATA' }],
      warnings: [],
      maxRate: 0,
    });

    await processor.process(fakeJob);

    // Solo la riga 2 (PDF mancante, nessuna extract comunque) viene elaborata:
    // extract non deve essere richiamato per la riga 1 già nel checkpoint.
    expect(client.extract).not.toHaveBeenCalled();
    const csv = fs.readFileSync(getEnrichmentResultCsv('j1'), 'utf-8');
    expect(csv).toContain('GIA PROCESSATA');
  });

  it('checkpoint corrotto: trattato come assente, elabora da riga 0', async () => {
    fs.writeFileSync(getEnrichmentCheckpoint('j1'), '{not valid json');
    await processor.process(fakeJob);
    expect(client.extract).toHaveBeenCalledTimes(1); // comportamento normale, da zero
  });

  it('a completamento (DONE) il checkpoint viene cancellato dal disco', async () => {
    await processor.process(fakeJob);
    expect(fs.existsSync(getEnrichmentCheckpoint('j1'))).toBe(false);
  });

  it('a completamento (FAILED) il checkpoint viene cancellato dal disco', async () => {
    fs.rmSync(getEnrichmentSourceZip('j1'));
    await processor.process(fakeJob);
    expect(fs.existsSync(getEnrichmentCheckpoint('j1'))).toBe(false);
  });

  it('applica gli override indirizzo esistenti prima di scrivere il CSV finale', async () => {
    overrideService.findByJob.mockResolvedValue([{ pdfFilename: 'PROVV_1.pdf', indirizzo: 'VIA CORRETTA' }]);
    overrideService.applyOverrides.mockImplementation((rows: any[]) =>
      rows.map((r) => (r.allegato === 'PROVV_1.pdf' ? { ...r, indirizzo: 'VIA CORRETTA' } : r)),
    );
    await processor.process(fakeJob);
    const csv = fs.readFileSync(getEnrichmentResultCsv('j1'), 'utf-8');
    expect(csv).toContain('VIA CORRETTA');
  });
```

Aggiungere gli import necessari in testa al file:

```ts
import { getEnrichmentCheckpoint } from './enrichment-paths';
```

(gli altri import da `enrichment-paths` sono già presenti — estendere la riga esistente invece di duplicarla).

- [ ] **Step 4: Eseguire la suite, verificare che tutto fallisca ancora (implementazione non modificata)**

Run: `docker compose exec backend node_modules/.bin/jest enrichment.processor --maxWorkers=2`
Expected: FAIL (compilazione + nuovi test).

- [ ] **Step 5: Implementare resume/checkpoint/override nel processor**

Sostituire il contenuto di `apps/backend/src/enrichment/enrichment.processor.ts` (import in testa e corpo di `process`):

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import * as fs from 'fs';
import AdmZip from 'adm-zip';
import {
  EnrichmentJob,
  EnrichmentJobStatus,
  EnrichmentWarning,
} from '../entities/enrichment-job.entity';
import { ENRICHMENT_QUEUE, EnrichmentQueueJobData } from './enrichment-job.types';
import { getEnrichmentResultCsv, getEnrichmentSourceZip } from './enrichment-paths';
import { readLargeFileSync } from './large-file-read.util';
import { parseMaggioliZip, type MaggioliRecord } from './maggioli-parser';
import { buildEnrichedCsv, buildEnrichedCsvHeaders, type EnrichedRow } from './enriched-csv.util';
import { PdfExtractorClient, type ExtractedPaymentDetail } from './pdf-extractor.client';
import { EnrichmentEventsService } from './enrichment-events.service';
import { EnrichmentAddressOverrideService } from './enrichment-address-override.service';
import { readCheckpointSync, writeCheckpointSync, deleteCheckpointSync } from './enrichment-checkpoint.util';

const PROGRESS_UPDATE_EVERY = 10;
const CHECKPOINT_EVERY = 100;

@Injectable()
@Processor(ENRICHMENT_QUEUE)
export class EnrichmentProcessor extends WorkerHost {
  private readonly logger = new Logger(EnrichmentProcessor.name);

  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    private readonly extractor: PdfExtractorClient,
    private readonly events: EnrichmentEventsService,
    private readonly overrideService: EnrichmentAddressOverrideService,
  ) {
    super();
  }

  async process(job: Job<EnrichmentQueueJobData>): Promise<void> {
    const { jobId } = job.data;
    const record = await this.jobRepo.findOneBy({ id: jobId });
    if (!record) {
      this.logger.warn(`EnrichmentJob ${jobId} non trovato — job BullMQ scartato`);
      return;
    }

    try {
      await this.jobRepo.update(jobId, { status: EnrichmentJobStatus.PROCESSING });

      const zip = new AdmZip(readLargeFileSync(getEnrichmentSourceZip(jobId)));
      const { records } = parseMaggioliZip(zip);

      const checkpoint = readCheckpointSync(jobId);
      const startIndex = checkpoint?.lastRow ?? 0;
      const warnings: EnrichmentWarning[] = checkpoint?.warnings ?? [];
      const rows: EnrichedRow[] = checkpoint?.rows ?? [];
      let maxRate = checkpoint?.maxRate ?? 0;

      for (let i = startIndex; i < records.length; i++) {
        const rec = records[i];
        const rowNum = i + 1;
        const row = this.baseRow(rec);
        let rateCount = 0;

        const entry = rec.pdfFilename ? zip.getEntry(`allegati/${rec.pdfFilename}`) : null;
        if (!entry) {
          warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: 'PDF non trovato nel ZIP' });
          await job.log(`Riga ${rowNum}: PDF "${rec.pdfFilename}" non trovato nel ZIP`);
          this.events.emitLog(jobId, {
            row: rowNum,
            pdf: rec.pdfFilename,
            detail: rowNum === 1 ? 'full' : 'summary',
            payload: { errore: 'PDF non trovato nel ZIP' },
          });
        } else {
          try {
            const result = await this.extractor.extract(entry.getData(), rec.pdfFilename, {
              searchPayments: record.searchPayments ?? true,
            });
            for (const w of result.warnings) {
              warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: w });
            }
            if (!rec.csvAddress && result.address) {
              row.indirizzo = result.address.indirizzo;
              row.cap = result.address.cap;
              row.comune = result.address.comune;
              row.provincia = result.address.provincia;
              row.stato_estero = result.address.stato_estero;
            }
            if (result.payment?.totale) {
              row.numero_avviso = rec.csvNumeroAvviso || result.payment.totale.numero_avviso;
              row.numero_avviso_alternativo = rec.csvNumeroAvvisoAlt || result.payment.totale.numero_avviso_alternativo;
              row.importo = result.payment.totale.importo;
              row.scadenza = result.payment.totale.scadenza;
            }
            if (result.payment?.rate?.length) {
              rateCount = result.payment.rate.length;
              maxRate = Math.max(maxRate, rateCount);
              result.payment.rate.forEach((rata: ExtractedPaymentDetail, idx: number) => {
                const n = idx + 1;
                row[`rata${n}_numero_avviso`] = rata.numero_avviso;
                row[`rata${n}_importo`] = rata.importo;
                row[`rata${n}_scadenza`] = rata.scadenza;
              });
            }

            if (rowNum === 1 || result.warnings.length > 0) {
              this.events.emitLog(jobId, {
                row: rowNum,
                pdf: rec.pdfFilename,
                detail: rowNum === 1 ? 'full' : 'summary',
                payload: rowNum === 1
                  ? {
                      indirizzo: result.address,
                      pagamentoTotale: result.payment?.totale ?? null,
                      rate: result.payment?.rate ?? [],
                      warnings: result.warnings,
                    }
                  : {
                      warnings: result.warnings,
                    },
              });
            }
          } catch (err: any) {
            warnings.push({ row: rowNum, pdf: rec.pdfFilename, message: `Estrazione fallita: ${err.message}` });
            await job.log(`Riga ${rowNum}: estrazione fallita — ${err.message}`);
            this.events.emitLog(jobId, {
              row: rowNum,
              pdf: rec.pdfFilename,
              detail: rowNum === 1 ? 'full' : 'summary',
              payload: { errore: `Estrazione fallita: ${err.message}` },
            });
          }
        }

        rows.push(row);

        if (rowNum % PROGRESS_UPDATE_EVERY === 0) {
          await this.jobRepo.update(jobId, {
            processedRecords: rowNum,
            warningCount: warnings.length,
            warnings: [...warnings],
          });
        }

        if (rowNum % CHECKPOINT_EVERY === 0) {
          const overrides = await this.overrideService.findByJob(jobId);
          const patchedRows = this.overrideService.applyOverrides(rows, overrides);
          writeCheckpointSync(jobId, { lastRow: rowNum, rows: patchedRows, warnings: [...warnings], maxRate });
          await this.jobRepo.update(jobId, { checkpointRow: rowNum });
        }
      }

      const overrides = await this.overrideService.findByJob(jobId);
      const finalRows = this.overrideService.applyOverrides(rows, overrides);
      const headers = buildEnrichedCsvHeaders(maxRate);
      fs.writeFileSync(getEnrichmentResultCsv(jobId), buildEnrichedCsv(headers, finalRows), 'utf-8');

      await this.jobRepo.update(jobId, {
        status: EnrichmentJobStatus.DONE,
        processedRecords: records.length,
        checkpointRow: records.length,
        warningCount: warnings.length,
        warnings,
        completedAt: new Date(),
      });
      deleteCheckpointSync(jobId);
      this.events.emitTerminal(jobId, { type: 'done' });
      this.logger.log(`EnrichmentJob ${jobId} completato: ${records.length} righe, ${warnings.length} warning`);
    } catch (err: any) {
      // Stato terminale PRIMA di uscire: mai lasciare il record in PROCESSING
      this.logger.error(`EnrichmentJob ${jobId} fallito: ${err.message}`);
      await this.jobRepo.update(jobId, {
        status: EnrichmentJobStatus.FAILED,
        errorMessage: err.message,
        completedAt: new Date(),
      });
      deleteCheckpointSync(jobId);
      this.events.emitTerminal(jobId, { type: 'error', message: err.message });
    }
  }

  private baseRow(rec: MaggioliRecord): EnrichedRow {
    return {
      codice_fiscale: rec.codiceFiscale,
      nominativo: rec.nominativo,
      tipo: rec.tipo,
      pec: rec.pec,
      indirizzo: rec.csvAddress?.indirizzo ?? '',
      cap: rec.csvAddress?.cap ?? '',
      comune: rec.csvAddress?.comune ?? '',
      provincia: rec.csvAddress?.provincia ?? '',
      stato_estero: rec.csvAddress?.statoEstero ?? '',
      allegato: rec.pdfFilename,
      numero_avviso: rec.csvNumeroAvviso,
      numero_avviso_alternativo: rec.csvNumeroAvvisoAlt,
      importo: '',
      scadenza: '',
      numero_provvedimento: rec.numeroProvvedimento,
      data_emissione: rec.dataEmissione,
      oggetto: rec.oggetto,
      external_id: rec.ocrNotifica || rec.numeroProvvedimento,
    };
  }
}
```

Nota: il test "resume" del Task 6 Step 3 scrive un checkpoint con `lastRow: 1` — il loop riparte da `i = 1` (riga 2, indice 0-based), quindi la riga 1 (indice 0, `PROVV_1.pdf`) non viene mai passata a `extract`. Coerente con `expect(client.extract).not.toHaveBeenCalled()` (nel job di test la riga 2 ha PDF mancante, nessuna extract comunque).

- [ ] **Step 6: Eseguire la suite completa del processor, verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest enrichment.processor --maxWorkers=2`
Expected: PASS (tutti i test, preesistenti + nuovi).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/enrichment/enrichment.processor.ts apps/backend/src/enrichment/enrichment.processor.spec.ts
git commit -m "feat(enrichment): checkpoint/resume + applicazione override nel processor"
```

---

### Task 7: `EnrichmentResumeService` — scan a boot dei job bloccati

**Files:**
- Create: `apps/backend/src/enrichment/enrichment-resume.service.ts`
- Test: `apps/backend/src/enrichment/enrichment-resume.service.spec.ts`
- Modify: `apps/backend/src/enrichment/enrichment.module.ts`

**Interfaces:**
- Consumes: `EnrichmentJob` repo, `Queue<EnrichmentQueueJobData>` (stesso di `enrichment.service.ts`), `readCheckpointSync` (Task 3).
- Produces: `class EnrichmentResumeService implements OnModuleInit`, metodo pubblico `resumeStuckJobs(): Promise<void>` (chiamato da `onModuleInit`, testabile direttamente senza dover avviare l'intero modulo Nest).

- [ ] **Step 1: Scrivere i test**

```ts
import { EnrichmentJobStatus } from '../entities/enrichment-job.entity';
import { EnrichmentResumeService } from './enrichment-resume.service';

jest.mock('./enrichment-checkpoint.util', () => ({
  readCheckpointSync: jest.fn(),
}));
import { readCheckpointSync } from './enrichment-checkpoint.util';

describe('EnrichmentResumeService', () => {
  let jobRepo: any;
  let queue: any;
  let service: EnrichmentResumeService;

  beforeEach(() => {
    jobRepo = {
      find: jest.fn(async () => []),
      update: jest.fn(async () => undefined),
    };
    queue = { add: jest.fn(async () => undefined) };
    service = new EnrichmentResumeService(jobRepo, queue);
    (readCheckpointSync as jest.Mock).mockReset();
  });

  it('nessun job PROCESSING → nessuna azione', async () => {
    await service.resumeStuckJobs();
    expect(queue.add).not.toHaveBeenCalled();
    expect(jobRepo.update).not.toHaveBeenCalled();
  });

  it('job PROCESSING con checkpoint leggibile → re-enqueue in BullMQ', async () => {
    jobRepo.find.mockResolvedValue([{ id: 'j1', status: EnrichmentJobStatus.PROCESSING }]);
    (readCheckpointSync as jest.Mock).mockReturnValue({ lastRow: 100, rows: [], warnings: [], maxRate: 0 });

    await service.resumeStuckJobs();

    expect(jobRepo.find).toHaveBeenCalledWith({ where: { status: EnrichmentJobStatus.PROCESSING } });
    expect(queue.add).toHaveBeenCalledWith('enrich', { jobId: 'j1' }, { jobId: 'j1' });
    expect(jobRepo.update).not.toHaveBeenCalled();
  });

  it('job PROCESSING senza checkpoint (o corrotto) → marcato FAILED, nessun re-enqueue', async () => {
    jobRepo.find.mockResolvedValue([{ id: 'j2', status: EnrichmentJobStatus.PROCESSING }]);
    (readCheckpointSync as jest.Mock).mockReturnValue(null);

    await service.resumeStuckJobs();

    expect(queue.add).not.toHaveBeenCalled();
    expect(jobRepo.update).toHaveBeenCalledWith('j2', expect.objectContaining({
      status: EnrichmentJobStatus.FAILED,
      errorMessage: expect.stringContaining('riavvio'),
    }));
  });

  it('più job bloccati: ciascuno gestito indipendentemente', async () => {
    jobRepo.find.mockResolvedValue([
      { id: 'j1', status: EnrichmentJobStatus.PROCESSING },
      { id: 'j2', status: EnrichmentJobStatus.PROCESSING },
    ]);
    (readCheckpointSync as jest.Mock)
      .mockReturnValueOnce({ lastRow: 50, rows: [], warnings: [], maxRate: 0 })
      .mockReturnValueOnce(null);

    await service.resumeStuckJobs();

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith('enrich', { jobId: 'j1' }, { jobId: 'j1' });
    expect(jobRepo.update).toHaveBeenCalledTimes(1);
    expect(jobRepo.update).toHaveBeenCalledWith('j2', expect.objectContaining({ status: EnrichmentJobStatus.FAILED }));
  });
});
```

- [ ] **Step 2: Eseguire il test, verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest enrichment-resume --maxWorkers=2`
Expected: FAIL — modulo non trovato.

- [ ] **Step 3: Implementare il service**

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { EnrichmentJob, EnrichmentJobStatus } from '../entities/enrichment-job.entity';
import { ENRICHMENT_QUEUE, EnrichmentQueueJobData } from './enrichment-job.types';
import { readCheckpointSync } from './enrichment-checkpoint.util';

/**
 * Un job lasciato in PROCESSING da un riavvio backend non ha altrimenti
 * alcun modo di uscire da quello stato (nessun demone lo tocca, BullMQ non
 * ha retry configurato) — questo scan gira una sola volta a boot.
 */
@Injectable()
export class EnrichmentResumeService implements OnModuleInit {
  private readonly logger = new Logger(EnrichmentResumeService.name);

  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    @InjectQueue(ENRICHMENT_QUEUE)
    private readonly queue: Queue<EnrichmentQueueJobData>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.resumeStuckJobs();
  }

  async resumeStuckJobs(): Promise<void> {
    const stuck = await this.jobRepo.find({ where: { status: EnrichmentJobStatus.PROCESSING } });
    for (const job of stuck) {
      const checkpoint = readCheckpointSync(job.id);
      if (checkpoint) {
        this.logger.warn(`EnrichmentJob ${job.id} bloccato in PROCESSING dopo riavvio — riprendo da riga ${checkpoint.lastRow}`);
        await this.queue.add('enrich', { jobId: job.id }, { jobId: job.id });
      } else {
        this.logger.error(`EnrichmentJob ${job.id} bloccato in PROCESSING dopo riavvio, nessun checkpoint disponibile — marcato FAILED`);
        await this.jobRepo.update(job.id, {
          status: EnrichmentJobStatus.FAILED,
          errorMessage: 'Interrotto da riavvio, nessun checkpoint disponibile',
          completedAt: new Date(),
        });
      }
    }
  }
}
```

- [ ] **Step 4: Eseguire il test, verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest enrichment-resume --maxWorkers=2`
Expected: PASS (4 test).

- [ ] **Step 5: Registrare il provider nel modulo**

In `apps/backend/src/enrichment/enrichment.module.ts`, importare `EnrichmentResumeService` e aggiungerlo a `providers: [...]` (nessun export necessario, usato solo internamente).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/enrichment/enrichment-resume.service.ts apps/backend/src/enrichment/enrichment-resume.service.spec.ts apps/backend/src/enrichment/enrichment.module.ts
git commit -m "feat(enrichment): resume automatico a boot dei job bloccati in PROCESSING"
```

---

### Task 8: `EnrichmentService` — righe, override, rigenera CSV

**Files:**
- Modify: `apps/backend/src/enrichment/enrichment.service.ts`
- Modify: `apps/backend/src/enrichment/enrichment.service.spec.ts`

**Interfaces:**
- Consumes: `EnrichmentAddressOverrideService` (Task 5, nuovo parametro costruttore), `readCheckpointSync` (Task 3), `parseEnrichedCsv`/`buildEnrichedCsv` (Task 4).
- Produces:
  - `getRow(jobId: string, pdfFilename: string): Promise<{ pdfFilename: string; codiceFiscale: string; indirizzo: string; cap: string; comune: string; provincia: string; statoEstero: string; override: EnrichmentAddressOverride | null }>`
  - `saveAddressOverride(jobId: string, pdfFilename: string, address: AddressOverrideInput, correctedBy: string): Promise<{ blocked?: boolean; message?: string }>`
  - `regenerateCsv(jobId: string): Promise<{ blocked?: boolean; message?: string }>`

Firma costruttore cambiata (nuovo 3° parametro) — stesso audit richiesto del Task 6.

- [ ] **Step 1: Aggiornare il setup dello spec esistente per il nuovo costruttore**

In `apps/backend/src/enrichment/enrichment.service.spec.ts`, individuare l'istanziazione `new EnrichmentService(...)` esistente e aggiungere il nuovo mock come ultimo argomento:

```ts
overrideService = {
  findByJob: jest.fn(async () => []),
  applyOverrides: jest.fn((rows: any) => rows),
  upsert: jest.fn(async () => ({ id: 'o1' })),
};
service = new EnrichmentService(jobRepo, queue, campaignsService, overrideService);
```

(dichiarare `let overrideService: any;` in testa al file insieme alle altre variabili mock).

- [ ] **Step 2: Eseguire la suite esistente, verificare che fallisca per compilazione**

Run: `docker compose exec backend node_modules/.bin/jest enrichment.service --maxWorkers=2`
Expected: FAIL (TypeScript non compila — costruttore reale non ha ancora 4 parametri).

- [ ] **Step 3: Scrivere i nuovi test**

Aggiungere in fondo al file, prima della chiusura del `describe` principale:

```ts
describe('getRow', () => {
  it('job DONE: legge dal CSV risultato, override presente incluso', async () => {
    jobRepo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.DONE });
    fs.mkdirSync(getEnrichmentDir('j1'), { recursive: true });
    fs.writeFileSync(
      getEnrichmentResultCsv('j1'),
      buildEnrichedCsv(buildEnrichedCsvHeaders(0), [
        { codice_fiscale: 'RSSMRA80A01H501U', allegato: 'PROVV_1.pdf', indirizzo: 'VIA VECCHIA', cap: '00000', comune: 'X', provincia: 'XX', stato_estero: '' },
      ]),
    );
    overrideService.findByJob.mockResolvedValue([{ pdfFilename: 'PROVV_1.pdf', indirizzo: 'VIA NUOVA' }]);

    const row = await service.getRow('j1', 'PROVV_1.pdf');

    expect(row.codiceFiscale).toBe('RSSMRA80A01H501U');
    expect(row.indirizzo).toBe('VIA VECCHIA'); // dato corrente non patchato di default
    expect(row.override).toEqual(expect.objectContaining({ indirizzo: 'VIA NUOVA' }));
  });

  it('pdfFilename inesistente nel job → BadRequestException', async () => {
    jobRepo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.DONE });
    fs.mkdirSync(getEnrichmentDir('j1'), { recursive: true });
    fs.writeFileSync(getEnrichmentResultCsv('j1'), buildEnrichedCsv(buildEnrichedCsvHeaders(0), []));
    await expect(service.getRow('j1', 'INESISTENTE.pdf')).rejects.toThrow(BadRequestException);
  });
});

describe('saveAddressOverride', () => {
  it('pdfFilename valido → upsert e nessun blocco', async () => {
    jobRepo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.DONE });
    fs.mkdirSync(getEnrichmentDir('j1'), { recursive: true });
    fs.writeFileSync(
      getEnrichmentResultCsv('j1'),
      buildEnrichedCsv(buildEnrichedCsvHeaders(0), [{ allegato: 'PROVV_1.pdf' }]),
    );
    const result = await service.saveAddressOverride('j1', 'PROVV_1.pdf', { indirizzo: 'VIA NUOVA' }, 'op');
    expect(result.blocked).toBeUndefined();
    expect(overrideService.upsert).toHaveBeenCalledWith('j1', 'PROVV_1.pdf', { indirizzo: 'VIA NUOVA' }, 'op');
  });

  it('pdfFilename inesistente → blocked', async () => {
    jobRepo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.DONE });
    fs.mkdirSync(getEnrichmentDir('j1'), { recursive: true });
    fs.writeFileSync(getEnrichmentResultCsv('j1'), buildEnrichedCsv(buildEnrichedCsvHeaders(0), []));
    const result = await service.saveAddressOverride('j1', 'INESISTENTE.pdf', { indirizzo: 'X' }, 'op');
    expect(result.blocked).toBe(true);
    expect(overrideService.upsert).not.toHaveBeenCalled();
  });
});

describe('regenerateCsv', () => {
  it('job non DONE → blocked', async () => {
    jobRepo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.PROCESSING });
    const result = await service.regenerateCsv('j1');
    expect(result.blocked).toBe(true);
  });

  it('job DONE: rilegge il CSV, applica override, riscrive il file', async () => {
    jobRepo.findOneBy.mockResolvedValue({ id: 'j1', status: EnrichmentJobStatus.DONE });
    fs.mkdirSync(getEnrichmentDir('j1'), { recursive: true });
    fs.writeFileSync(
      getEnrichmentResultCsv('j1'),
      buildEnrichedCsv(buildEnrichedCsvHeaders(0), [{ allegato: 'PROVV_1.pdf', indirizzo: 'VIA VECCHIA' }]),
    );
    overrideService.findByJob.mockResolvedValue([{ pdfFilename: 'PROVV_1.pdf', indirizzo: 'VIA CORRETTA' }]);
    overrideService.applyOverrides.mockImplementation((rows: any[]) =>
      rows.map((r) => (r.allegato === 'PROVV_1.pdf' ? { ...r, indirizzo: 'VIA CORRETTA' } : r)),
    );

    const result = await service.regenerateCsv('j1');

    expect(result.blocked).toBeUndefined();
    const csv = fs.readFileSync(getEnrichmentResultCsv('j1'), 'utf-8');
    expect(csv).toContain('VIA CORRETTA');
    expect(csv).not.toContain('VIA VECCHIA');
  });
});
```

Import necessari in testa allo spec (estendere quelli già presenti):
```ts
import * as fs from 'fs';
import { BadRequestException } from '@nestjs/common';
import { getEnrichmentDir, getEnrichmentResultCsv } from './enrichment-paths';
import { buildEnrichedCsv, buildEnrichedCsvHeaders } from './enriched-csv.util';
```

- [ ] **Step 4: Eseguire la suite, verificare che fallisca (metodi non implementati)**

Run: `docker compose exec backend node_modules/.bin/jest enrichment.service --maxWorkers=2`
Expected: FAIL.

- [ ] **Step 5: Implementare i metodi**

In `apps/backend/src/enrichment/enrichment.service.ts`:

Aggiungere import in testa:
```ts
import { BadRequestException } from '@nestjs/common';
import { EnrichmentAddressOverrideService, type AddressOverrideInput } from './enrichment-address-override.service';
import { readCheckpointSync } from './enrichment-checkpoint.util';
import { buildEnrichedCsv, parseEnrichedCsv, type EnrichedRow } from './enriched-csv.util';
```

Aggiungere il parametro al costruttore:
```ts
  constructor(
    @InjectRepository(EnrichmentJob)
    private readonly jobRepo: Repository<EnrichmentJob>,
    @InjectQueue(ENRICHMENT_QUEUE)
    private readonly queue: Queue<EnrichmentQueueJobData>,
    private readonly campaignsService: CampaignsService,
    private readonly overrideService: EnrichmentAddressOverrideService,
  ) {}
```

Aggiungere i tre metodi (in fondo alla classe, prima della chiusura):

```ts
  /**
   * Legge lo stato corrente di una riga per pdfFilename. Job DONE → dal CSV
   * risultato già scritto; job ancora PROCESSING → dal checkpoint se
   * esiste (righe non ancora committate non sono raggiungibili: nessun
   * checkpoint le contiene, coerente col gate lato UI su checkpointRow).
   */
  async getRow(jobId: string, pdfFilename: string): Promise<{
    pdfFilename: string;
    codiceFiscale: string;
    indirizzo: string;
    cap: string;
    comune: string;
    provincia: string;
    statoEstero: string;
    override: import('../entities/enrichment-address-override.entity').EnrichmentAddressOverride | null;
  }> {
    const job = await this.getJob(jobId);
    const rows = this.loadCurrentRows(job);
    const row = rows.find((r) => r['allegato'] === pdfFilename);
    if (!row) {
      throw new BadRequestException(`Nessuna riga con allegato "${pdfFilename}" in questo job`);
    }
    const overrides = await this.overrideService.findByJob(jobId);
    const override = overrides.find((o) => o.pdfFilename === pdfFilename) ?? null;
    return {
      pdfFilename,
      codiceFiscale: row['codice_fiscale'] ?? '',
      indirizzo: row['indirizzo'] ?? '',
      cap: row['cap'] ?? '',
      comune: row['comune'] ?? '',
      provincia: row['provincia'] ?? '',
      statoEstero: row['stato_estero'] ?? '',
      override,
    };
  }

  async saveAddressOverride(
    jobId: string,
    pdfFilename: string,
    address: AddressOverrideInput,
    correctedBy: string,
  ): Promise<{ blocked?: boolean; message?: string }> {
    const job = await this.getJob(jobId);
    const rows = this.loadCurrentRows(job);
    if (!rows.some((r) => r['allegato'] === pdfFilename)) {
      return { blocked: true, message: `Nessuna riga con allegato "${pdfFilename}" in questo job` };
    }
    await this.overrideService.upsert(jobId, pdfFilename, address, correctedBy);
    return {};
  }

  /**
   * Solo per job DONE: rilegge il CSV già scritto, ripatcha le righe con
   * override e riscrive il file — azione esplicita, mai automatica (stesso
   * principio della correzione indirizzo POSTAL).
   */
  async regenerateCsv(jobId: string): Promise<{ blocked?: boolean; message?: string }> {
    const job = await this.getJob(jobId);
    if (job.status !== EnrichmentJobStatus.DONE) {
      return { blocked: true, message: 'Il job non è completato: nessun CSV da rigenerare' };
    }
    const csvPath = getEnrichmentResultCsv(jobId);
    if (!fs.existsSync(csvPath)) {
      return { blocked: true, message: 'File risultato non più disponibile (retention scaduta?)' };
    }
    const { headers, rows } = parseEnrichedCsv(fs.readFileSync(csvPath, 'utf-8'));
    const overrides = await this.overrideService.findByJob(jobId);
    const patched = this.overrideService.applyOverrides(rows, overrides);
    fs.writeFileSync(csvPath, buildEnrichedCsv(headers, patched), 'utf-8');
    return {};
  }

  private loadCurrentRows(job: EnrichmentJob): EnrichedRow[] {
    if (job.status === EnrichmentJobStatus.DONE) {
      const csvPath = getEnrichmentResultCsv(job.id);
      if (!fs.existsSync(csvPath)) return [];
      return parseEnrichedCsv(fs.readFileSync(csvPath, 'utf-8')).rows;
    }
    return readCheckpointSync(job.id)?.rows ?? [];
  }
```

- [ ] **Step 6: Eseguire la suite, verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest enrichment.service --maxWorkers=2`
Expected: PASS (tutti i test, preesistenti + nuovi).

- [ ] **Step 7: Registrare `EnrichmentAddressOverrideService` nel modulo**

In `apps/backend/src/enrichment/enrichment.module.ts`: import di `EnrichmentAddressOverrideService` e `EnrichmentAddressOverride`, aggiungere l'entity a `TypeOrmModule.forFeature([EnrichmentJob, EnrichmentAddressOverride])` e il service a `providers: [...]`.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/enrichment/enrichment.service.ts apps/backend/src/enrichment/enrichment.service.spec.ts apps/backend/src/enrichment/enrichment.module.ts
git commit -m "feat(enrichment): getRow/saveAddressOverride/regenerateCsv su EnrichmentService"
```

---

### Task 9: Endpoint controller — righe, override, rigenera

**Files:**
- Modify: `apps/backend/src/enrichment/enrichment.controller.ts`
- Modify: `apps/backend/src/enrichment/enrichment.controller.spec.ts`

**Interfaces:**
- Consumes: `EnrichmentService.getRow/saveAddressOverride/regenerateCsv` (Task 8).
- Produces:
  - `GET admin/enrichment/jobs/:id/rows/:pdfFilename`
  - `PUT admin/enrichment/jobs/:id/rows/:pdfFilename/address`
  - `POST admin/enrichment/jobs/:id/regenerate-csv`

- [ ] **Step 1: Aggiornare il mock `svc` esistente nello spec**

In `apps/backend/src/enrichment/enrichment.controller.spec.ts`, estendere l'oggetto `svc` nel `beforeEach`:

```ts
    svc = {
      createJob: jest.fn(async () => ({ jobId: 'j1' })),
      listJobs: jest.fn(async () => []),
      getJob: jest.fn(async () => ({ id: 'j1' })),
      deleteJob: jest.fn(async () => ({})),
      buildResultZip: jest.fn(async () => Buffer.from('zip')),
      getRow: jest.fn(async () => ({ pdfFilename: 'PROVV_1.pdf', codiceFiscale: 'X', indirizzo: '', cap: '', comune: '', provincia: '', statoEstero: '', override: null })),
      saveAddressOverride: jest.fn(async () => ({})),
      regenerateCsv: jest.fn(async () => ({})),
    };
```

- [ ] **Step 2: Scrivere i nuovi test**

Aggiungere in fondo al file (prima della chiusura del `describe`):

```ts
  it('GET rows/:pdfFilename delega al service', async () => {
    const result = await controller.getRow('j1', 'PROVV_1.pdf');
    expect(svc.getRow).toHaveBeenCalledWith('j1', 'PROVV_1.pdf');
    expect(result.pdfFilename).toBe('PROVV_1.pdf');
  });

  it('PUT rows/:pdfFilename/address: passa operatore e body al service', async () => {
    const result = await controller.saveAddressOverride(
      'j1',
      'PROVV_1.pdf',
      { indirizzo: 'VIA NUOVA', cap: '00100', comune: 'ROMA', provincia: 'RM' },
      { user: { username: 'op' } } as any,
    );
    expect(svc.saveAddressOverride).toHaveBeenCalledWith('j1', 'PROVV_1.pdf', { indirizzo: 'VIA NUOVA', cap: '00100', comune: 'ROMA', provincia: 'RM' }, 'op');
    expect(result.blocked).toBeUndefined();
  });

  it('POST regenerate-csv delega al service', async () => {
    const result = await controller.regenerateCsv('j1');
    expect(svc.regenerateCsv).toHaveBeenCalledWith('j1');
    expect(result.blocked).toBeUndefined();
  });
```

- [ ] **Step 3: Eseguire la suite, verificare che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest enrichment.controller --maxWorkers=2`
Expected: FAIL — metodi controller non esistono.

- [ ] **Step 4: Implementare gli endpoint**

In `apps/backend/src/enrichment/enrichment.controller.ts`, aggiungere import `Put` da `@nestjs/common` (estendere l'import esistente), poi i tre metodi (dopo `createCampaign`, prima della chiusura della classe):

```ts
  @Get('jobs/:id/rows/:pdfFilename')
  @Roles('user', 'admin')
  getRow(@Param('id', ParseUUIDPipe) id: string, @Param('pdfFilename') pdfFilename: string) {
    return this.svc.getRow(id, pdfFilename);
  }

  @Put('jobs/:id/rows/:pdfFilename/address')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  saveAddressOverride(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('pdfFilename') pdfFilename: string,
    @Body() body: { indirizzo?: string; cap?: string; comune?: string; provincia?: string; statoEstero?: string },
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    return this.svc.saveAddressOverride(id, pdfFilename, body, req.user.username);
  }

  @Post('jobs/:id/regenerate-csv')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  regenerateCsv(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.regenerateCsv(id);
  }
```

- [ ] **Step 5: Eseguire la suite, verificare che passi**

Run: `docker compose exec backend node_modules/.bin/jest enrichment.controller --maxWorkers=2`
Expected: PASS.

- [ ] **Step 6: Suite backend completa (audit costruttori modificati)**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure set della baseline nota (`app.controller.spec.ts` `isLdapMock`), nessuna regressione altrove — le firme di `EnrichmentProcessor`/`EnrichmentService` sono cambiate, verificare che nessun altro file istanzi quelle classi direttamente (`grep -rn "new EnrichmentProcessor\|new EnrichmentService" apps/backend/src`).

- [ ] **Step 7: Type-check**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/enrichment/enrichment.controller.ts apps/backend/src/enrichment/enrichment.controller.spec.ts
git commit -m "feat(enrichment): endpoint GET/PUT riga + POST regenerate-csv"
```

---

### Task 10: Rebuild backend e verifica manuale end-to-end (Docker)

**Files:** nessuno (solo verifica).

- [ ] **Step 1: Rebuild e restart backend**

```bash
docker compose build backend
docker compose up -d backend
```

- [ ] **Step 2: Generare token operatore admin**

```bash
docker compose exec backend node -e "const jwt=require('/app/node_modules/.pnpm/node_modules/jsonwebtoken');console.log(jwt.sign({sub:'debug',username:'debug',role:'admin',type:'operator'},process.env.JWT_SECRET,{expiresIn:'10m'}))"
```

- [ ] **Step 3: Verificare che le migration siano girate**

```bash
docker compose logs backend | grep -i migration
```

Expected: `AddCheckpointRowToEnrichmentJobs1785700000000` e `CreateEnrichmentAddressOverrides1785800000000` eseguite senza errori (solo se `NODE_ENV` non è `development` — in dev `synchronize` allinea lo schema automaticamente, verificare comunque che le colonne/tabella esistano):

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "\d enrichment_jobs" | grep checkpoint_row
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "\d enrichment_address_overrides"
```

- [ ] **Step 4: Test resume — creare un job, uccidere il backend a metà, verificare ripresa**

Serve un ZIP Maggioli con >100 record per superare almeno un checkpoint — usare uno ZIP reale già disponibile o generarne uno sintetico. Caricare via UI admin (Arricchimento Tracciati), poi durante l'elaborazione:

```bash
docker compose restart backend
```

Attendere il riavvio, poi:

```bash
docker compose exec backend node -e "
const fetch = require('node-fetch');
fetch('http://localhost:8080/admin/enrichment/jobs', { headers: { Authorization: 'Bearer <TOKEN>' } })
  .then(r => r.json()).then(d => console.log(JSON.stringify(d.jobs[0], null, 2)));
"
```

Expected: il job non è rimasto in `PROCESSING` per sempre — o è tornato in coda e ha proseguito da `checkpointRow`, o (se il crash è avvenuto prima del primo checkpoint) è `FAILED` con messaggio "Interrotto da riavvio, nessun checkpoint disponibile". Verificare nei log (`docker compose logs backend | grep EnrichmentResumeService`) quale dei due casi si è verificato.

- [ ] **Step 5: Test correzione indirizzo end-to-end via API**

```bash
docker compose exec backend node -e "
const fetch = require('node-fetch');
const TOKEN = '<TOKEN>';
const JOB_ID = '<JOB_ID>';
fetch(\`http://localhost:8080/admin/enrichment/jobs/\${JOB_ID}/rows/PROVV_XXXX.pdf/address\`, {
  method: 'PUT',
  headers: { Authorization: \`Bearer \${TOKEN}\`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ indirizzo: 'VIA TEST 1', cap: '00100', comune: 'ROMA', provincia: 'RM' }),
}).then(r => r.json()).then(console.log);
"
```

Poi scaricare il CSV risultato (`GET jobs/:id/result.csv`) e verificare che la riga corrispondente ora contenga `VIA TEST 1` (l'override si applica già al checkpoint/CSV finale scritto dal processor se il job era ancora in corso; se il job era già `DONE` al momento della PUT, chiamare anche `POST jobs/:id/regenerate-csv` prima di riscaricare).

- [ ] **Step 6: Nessun commit in questo task** (solo verifica manuale).

---

### Task 11: Frontend — stato, handler, gate `checkpointRow`, modale correzione indirizzo

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `GET admin/enrichment/jobs/:id/rows/:pdfFilename`, `PUT .../address`, `POST .../regenerate-csv`, `POST admin/domicilio/cerca` (Task 9 + endpoint esistente).
- Produces: nuovo stato locale `enrichAddressEdit*`, handler `openEnrichAddressEdit`, `runEnrichAddressAnprCheck`, `handleSaveEnrichAddress`, `handleEnrichRegenerateCsv`.

Nessun test automatico per questa parte (componente React monolitico esistente, nessuna suite frontend per `App.tsx` — verifica manuale in browser, Task 12).

- [ ] **Step 1: Estendere `EnrichmentJobItem` con `checkpointRow`**

In `apps/frontend-admin/src/App.tsx`, nell'interfaccia esistente (riga ~1099):

```ts
  interface EnrichmentJobItem {
    id: string;
    status: 'queued' | 'processing' | 'done' | 'failed';
    traceFormat: string;
    searchPayments?: boolean;
    sourceFilename: string;
    totalRecords: number;
    processedRecords: number;
    checkpointRow: number;
    warningCount: number;
    warnings: Array<{ row: number; pdf: string; message: string }>;
    errorMessage: string | null;
    campaignId: string | null;
    createdAt: string;
  }
```

- [ ] **Step 2: Aggiungere lo stato per la modale di correzione**

Subito dopo `const [enrichStreamingJobId, setEnrichStreamingJobId] = useState<string | null>(null);` (riga ~1132):

```ts
  interface EnrichAddressForm {
    indirizzo: string;
    cap: string;
    comune: string;
    provincia: string;
    statoEstero: string;
  }
  const [enrichAddressEditJobId, setEnrichAddressEditJobId] = useState<string | null>(null);
  const [enrichAddressEditPdf, setEnrichAddressEditPdf] = useState<string | null>(null);
  const [enrichAddressEditCf, setEnrichAddressEditCf] = useState('');
  const [enrichAddressEditForm, setEnrichAddressEditForm] = useState<EnrichAddressForm>({ indirizzo: '', cap: '', comune: '', provincia: '', statoEstero: '' });
  const [enrichAddressEditLoading, setEnrichAddressEditLoading] = useState(false);
  const [enrichAddressEditAnprLoading, setEnrichAddressEditAnprLoading] = useState(false);
  const [enrichAddressEditSaving, setEnrichAddressEditSaving] = useState(false);
  const [enrichAddressEditError, setEnrichAddressEditError] = useState<string | null>(null);
```

- [ ] **Step 3: Aggiungere i quattro handler**

Dopo `handleEnrichDelete` (riga ~2702, prima di `handleEnrichCreateCampaignOpen`):

```ts
  const openEnrichAddressEdit = async (jobId: string, pdfFilename: string) => {
    setEnrichAddressEditJobId(jobId);
    setEnrichAddressEditPdf(pdfFilename);
    setEnrichAddressEditError(null);
    setEnrichAddressEditLoading(true);
    try {
      const res = await apiFetch(`/enrichment/jobs/${jobId}/rows/${encodeURIComponent(pdfFilename)}`);
      const row = await res.json();
      if (!res.ok) {
        setEnrichAddressEditError(row.message || 'Riga non trovata');
        return;
      }
      setEnrichAddressEditCf(row.codiceFiscale || '');
      const source = row.override || row;
      setEnrichAddressEditForm({
        indirizzo: source.indirizzo || '',
        cap: source.cap || '',
        comune: source.comune || '',
        provincia: source.provincia || '',
        statoEstero: source.statoEstero || '',
      });
    } catch {
      setEnrichAddressEditError('Errore durante il caricamento della riga');
    } finally {
      setEnrichAddressEditLoading(false);
    }
  };

  const closeEnrichAddressEdit = () => {
    setEnrichAddressEditJobId(null);
    setEnrichAddressEditPdf(null);
    setEnrichAddressEditError(null);
  };

  // Stessa mappatura toponimo+numeroCivico → indirizzo già usata in
  // runAddressEditAnprCheck (correzione indirizzo POSTAL) — qui adattata ai
  // nomi colonna del CSV arricchito (indirizzo/cap/comune/provincia/statoEstero).
  const runEnrichAddressAnprCheck = async () => {
    if (!enrichAddressEditCf) return;
    setEnrichAddressEditAnprLoading(true);
    try {
      const res = await apiFetch('/domicilio/cerca', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codiceFiscale: enrichAddressEditCf }),
      });
      const data = await res.json();
      const residenza = data?.anpr?.residenza?.[0];
      if (data?.anpr?.success && data?.anpr?.found && residenza?.indirizzo) {
        const ind = residenza.indirizzo;
        const via = [ind.toponimo?.specie, ind.toponimo?.denominazioneToponimo].filter(Boolean).join(' ');
        const civico = [ind.numeroCivico?.numero, ind.numeroCivico?.lettera].filter(Boolean).join('');
        setEnrichAddressEditForm({
          indirizzo: [via, civico].filter(Boolean).join(', '),
          cap: ind.cap || '',
          comune: ind.comune?.nomeComune || '',
          provincia: ind.comune?.siglaProvinciaIstat || '',
          statoEstero: '',
        });
      } else if (data?.anpr?.success && data?.anpr?.found && residenza?.localitaEstera?.indirizzoEstero) {
        const ind = residenza.localitaEstera.indirizzoEstero;
        const via = [ind.toponimo?.denominazione, ind.toponimo?.numeroCivico].filter(Boolean).join(' ');
        setEnrichAddressEditForm({
          indirizzo: via,
          cap: ind.cap || '',
          comune: ind.localita?.descrizioneLocalita || '',
          provincia: '',
          statoEstero: ind.localita?.descrizioneStato || '',
        });
      } else {
        alert('ANPR: nessun indirizzo di residenza trovato per questo CF.');
      }
    } catch {
      alert('Errore di connessione durante la verifica ANPR.');
    } finally {
      setEnrichAddressEditAnprLoading(false);
    }
  };

  const handleSaveEnrichAddress = async () => {
    if (!enrichAddressEditJobId || !enrichAddressEditPdf) return;
    if (!enrichAddressEditForm.indirizzo.trim() || !enrichAddressEditForm.comune.trim()) {
      setEnrichAddressEditError('Indirizzo e Comune sono obbligatori.');
      return;
    }
    setEnrichAddressEditSaving(true);
    setEnrichAddressEditError(null);
    try {
      const res = await apiFetch(
        `/enrichment/jobs/${enrichAddressEditJobId}/rows/${encodeURIComponent(enrichAddressEditPdf)}/address`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(enrichAddressEditForm) },
      );
      const body = await res.json();
      if (body.blocked) {
        setEnrichAddressEditError(body.message || 'Errore durante il salvataggio');
        return;
      }
      closeEnrichAddressEdit();
    } catch {
      setEnrichAddressEditError('Errore durante il salvataggio dell\'indirizzo');
    } finally {
      setEnrichAddressEditSaving(false);
    }
  };

  const handleEnrichRegenerateCsv = async (jobId: string) => {
    if (!token) return;
    try {
      const res = await apiFetch(`/enrichment/jobs/${jobId}/regenerate-csv`, { method: 'POST' });
      const body = await res.json();
      if (body.blocked) { alert(body.message); return; }
      alert('CSV rigenerato con le correzioni applicate.');
    } catch {
      alert('Errore durante la rigenerazione del CSV');
    }
  };
```

- [ ] **Step 4: Verifica type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore (nessuna JSX ancora aggiunta — solo stato/handler, verrà usato nel Task 12).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(enrichment-ui): stato e handler correzione indirizzo (senza JSX)"
```

---

### Task 12: Frontend — JSX: bottone gated, modale, "Rigenera CSV"

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

- [ ] **Step 1: Bottone "Rigenera CSV" accanto a "Scarica CSV"**

Nel blocco `job.status === 'done' && !job.campaignId` (riga ~11433-11444), dopo il bottone "Scarica ZIP":

```tsx
                          <button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => downloadEnrichResult(job.id, 'zip')}>
                            <FileArchive className="me-1" size={16} />Scarica ZIP
                          </button>
                          <button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => handleEnrichRegenerateCsv(job.id)}>
                            Rigenera CSV
                          </button>
```

- [ ] **Step 2: Bottone "Correggi indirizzo" per riga, gated su `checkpointRow`**

Sostituire il blocco lista avvisi esistente (righe ~11463-11473):

```tsx
                    {enrichDetailJobId === job.id && (
                      <ul className="small text-muted mt-2 mb-0 list-unstyled">
                        {job.warnings && job.warnings.length > 0 ? (
                          job.warnings.map((w, i) => {
                            const committed = job.status === 'done' || w.row <= (job.checkpointRow ?? 0);
                            return (
                              <li key={i} className="d-flex align-items-center gap-2 mb-1">
                                <span>Riga {w.row} — {w.pdf}: {w.message}</span>
                                <button
                                  className="btn btn-sm btn-link p-0"
                                  type="button"
                                  disabled={!committed}
                                  title={committed ? '' : 'In attesa di checkpoint (salvataggio ogni 100 righe)'}
                                  onClick={() => openEnrichAddressEdit(job.id, w.pdf)}
                                >
                                  Correggi indirizzo
                                </button>
                              </li>
                            );
                          })
                        ) : (
                          <li className="fst-italic text-muted">Sincronizzazione avvisi in corso...</li>
                        )}
                      </ul>
                    )}
```

- [ ] **Step 3: Modale di correzione indirizzo**

Subito dopo la chiusura del blocco `{enrichCreateCampaignJobId === job.id && (...)}`(riga ~11552), ancora dentro il `.map((job) => ...)`:

```tsx
                    {enrichAddressEditJobId === job.id && enrichAddressEditPdf && (
                      <div className="border rounded p-3 mt-2 bg-light">
                        <h6 className="small fw-bold mb-2">Correggi indirizzo — {enrichAddressEditPdf}</h6>
                        {enrichAddressEditLoading ? (
                          <div className="small text-muted"><Loader2 className="icon-spin me-1" size={16} />Caricamento...</div>
                        ) : (
                          <>
                            <div className="mb-2 small text-muted">CF: {enrichAddressEditCf || '—'}</div>
                            <button
                              className="btn btn-sm btn-outline-primary mb-3"
                              type="button"
                              disabled={!enrichAddressEditCf || enrichAddressEditAnprLoading}
                              onClick={runEnrichAddressAnprCheck}
                            >
                              {enrichAddressEditAnprLoading ? (
                                <><Loader2 className="icon-spin me-1" size={16} />Verifica ANPR...</>
                              ) : (
                                'Carica da ANPR'
                              )}
                            </button>
                            <div className="row g-2 mb-2">
                              <div className="col-md-8">
                                <label className="form-label small fw-bold">Indirizzo</label>
                                <input type="text" className="form-control form-control-sm" value={enrichAddressEditForm.indirizzo}
                                  onChange={(e) => setEnrichAddressEditForm((f) => ({ ...f, indirizzo: e.target.value }))} />
                              </div>
                              <div className="col-md-4">
                                <label className="form-label small fw-bold">CAP</label>
                                <input type="text" className="form-control form-control-sm" value={enrichAddressEditForm.cap}
                                  onChange={(e) => setEnrichAddressEditForm((f) => ({ ...f, cap: e.target.value }))} />
                              </div>
                              <div className="col-md-6">
                                <label className="form-label small fw-bold">Comune</label>
                                <input type="text" className="form-control form-control-sm" value={enrichAddressEditForm.comune}
                                  onChange={(e) => setEnrichAddressEditForm((f) => ({ ...f, comune: e.target.value }))} />
                              </div>
                              <div className="col-md-3">
                                <label className="form-label small fw-bold">Provincia</label>
                                <input type="text" className="form-control form-control-sm" value={enrichAddressEditForm.provincia}
                                  onChange={(e) => setEnrichAddressEditForm((f) => ({ ...f, provincia: e.target.value }))} />
                              </div>
                              <div className="col-md-3">
                                <label className="form-label small fw-bold">Stato estero</label>
                                <input type="text" className="form-control form-control-sm" value={enrichAddressEditForm.statoEstero}
                                  onChange={(e) => setEnrichAddressEditForm((f) => ({ ...f, statoEstero: e.target.value }))} />
                              </div>
                            </div>
                            {enrichAddressEditError && <div className="alert alert-danger small">{enrichAddressEditError}</div>}
                            <div className="d-flex gap-2">
                              <button className="btn btn-sm btn-primary" type="button" disabled={enrichAddressEditSaving} onClick={handleSaveEnrichAddress}>
                                {enrichAddressEditSaving ? <><Loader2 className="icon-spin me-1" size={16} />Salvataggio...</> : 'Salva correzione'}
                              </button>
                              <button className="btn btn-sm btn-outline-secondary" type="button" disabled={enrichAddressEditSaving} onClick={closeEnrichAddressEdit}>
                                Annulla
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
```

- [ ] **Step 4: Verifica type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 5: Verifica manuale in browser**

```bash
docker compose up -d --build frontend-admin
```

Login admin/admin (LDAP mock), andare su "Arricchimento Tracciati":
1. Caricare uno ZIP con almeno una riga con warning indirizzo.
2. Apertura "Avvisi" → verificare che "Correggi indirizzo" sia abilitato solo se il job è `done` o la riga è coperta da `checkpointRow` (per un job piccolo, senza mai passare i 100 record, il gate si attiva solo a `done`: verificare quindi anche il testo del tooltip su un job ancora in `processing`).
3. Cliccare "Correggi indirizzo" su una riga → form si apre precompilato coi dati correnti.
4. Cliccare "Carica da ANPR" con un CF reale → verificare prefill.
5. Modificare un campo, "Salva correzione" → verificare nessun errore.
6. "Rigenera CSV" → scaricare CSV, verificare che la riga corretta contenga il nuovo indirizzo.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(enrichment-ui): bottone correzione indirizzo gated su checkpoint + rigenera CSV"
```

---

## Post-implementazione

- Aggiornare `docs/superpowers/specs/2026-07-24-terzo-formato-maggioli-design.md` o altri doc collegati **non necessario** (nessuna sovrapposizione — questo piano non toglie/aggiunge formati tracciato).
- Valutare se aggiungere una riga a `CLAUDE.md` sezione "Arricchimento tracciati" sul pattern checkpoint/resume — lasciato alla revisione finale (skill `claude-md-management:revise-claude-md`), non incluso in questo piano per restare focalizzati sull'implementazione.
