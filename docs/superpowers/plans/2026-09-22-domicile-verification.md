# Verifica Domicili Digitali unificata — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sostituire i due pannelli massivi separati ("Verifica App IO massiva", "Verifica INAD massiva") con un unico job persistente che verifica INAD+App IO sui CF fisici e Registro Imprese (subito per le PIVA, come fallback per i CF fisici non trovati da INAD), con storico job, retention 7gg e 5 CSV di output.

**Architecture:** Nuova entità `DomicileVerificationJob` (sostituisce `InadVerificationJob`+`AppIoVerificationJob`). Un service crea il job e accoda le verifiche sulle code BullMQ esistenti (App IO, INAD via chiamate dirette, Registro Imprese via coda già esistente); un cron sync orchestra le fasi e costruisce i 5 CSV a completamento; un cron retention elimina i job scaduti. Il processor App IO e il processor Registro Imprese esistenti vengono ripuntati sulla nuova tabella, comportamento di dominio invariato.

**Tech Stack:** NestJS 12 (ESM), TypeORM, BullMQ (`@nestjs/bullmq`), Vitest (shim `jest.*`), React 19 (frontend-admin, `App.tsx`).

**Spec:** `docs/superpowers/specs/2026-09-22-domicile-verification-design.md`

## Global Constraints

- Backend ESM: ogni import relativo richiede `.js` esplicito (`moduleResolution: NodeNext`).
- Test: Vitest con shim `jest.*` (`vitest.setup.ts`) — mock con `jest.fn()`, mai `vi.mock()` letterale per i file toccati qui (nessun mock di modulo intero necessario in questo piano).
- Nessun `pnpm --filter`/`pnpm run` dentro i container — build/test sempre con binario diretto via `docker compose exec backend node_modules/.bin/<tool>`.
- Retention default: **7 giorni** (`domicileVerification.retentionDays`, come richiesto).
- CSV: sempre via `parseCsvContent`/`buildCsvContent` esistenti (`apps/backend/src/io-services/csv.util.ts`), mai reinventare il parsing.
- "Trovato" INAD = `digitalAddress` non vuoto (mai altra condizione).
- Registro Imprese sui CF fisici: **solo fallback** sui non-trovati INAD, mai su tutti.
- Ogni comando Docker va eseguito così com'è indicato negli step (container `backend` già in esecuzione, `docker compose up -d` nel dev locale).

---

### Task 1: Entità `DomicileVerificationJob` + migration

**Files:**
- Create: `apps/backend/src/entities/domicile-verification-job.entity.ts`
- Create: `apps/backend/src/database/migrations/1789900000000-CreateDomicileVerificationJobs.ts`
- Modify: `apps/backend/src/database/database.module.ts`
- Modify: `apps/backend/src/database/data-source.ts`

**Interfaces:**
- Produces: `DomicileVerificationJob` (entity class), `DomicileVerificationJobStatus` (enum: `QUEUED`/`PROCESSING`/`DONE`/`FAILED`), `DomicileInadBatch` (`{id, size, done}`) — usati da tutti i task successivi.

- [ ] **Step 1: Creare l'entità**

```ts
// apps/backend/src/entities/domicile-verification-job.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum DomicileVerificationJobStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  DONE = 'done',
  FAILED = 'failed',
}

export interface DomicileInadBatch {
  id: string;
  size: number;
  done: boolean;
}

@Entity('domicile_verification_jobs')
export class DomicileVerificationJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    type: 'enum',
    enum: DomicileVerificationJobStatus,
    default: DomicileVerificationJobStatus.QUEUED,
  })
  status!: DomicileVerificationJobStatus;

  @Column({ name: 'total_rows', type: 'int', default: 0 })
  totalRows!: number;

  /** Contenuto raw del CSV caricato, riparsato a completamento per costruire i 5 CSV risultato. */
  @Column({ name: 'source_csv', type: 'text' })
  sourceCsv!: string;

  @Column({ name: 'csv_headers', type: 'jsonb' })
  csvHeaders!: string[];

  @Column({ name: 'cf_column', type: 'varchar', length: 256 })
  cfColumn!: string;

  @Column({ name: 'has_headers', type: 'boolean', default: true })
  hasHeaders!: boolean;

  @Column({ name: 'io_service_id', type: 'uuid' })
  ioServiceId!: string;

  @Column({ name: 'cf_fisico_total', type: 'int', default: 0 })
  cfFisicoTotal!: number;

  @Column({ name: 'piva_total', type: 'int', default: 0 })
  pivaTotal!: number;

  /** Un elemento per ogni chiamata POST /listDigitalAddress (max 1000 CF ciascuna). */
  @Column({ name: 'inad_batches', type: 'jsonb', default: [] })
  inadBatches!: DomicileInadBatch[];

  /** true dopo che i risultati dei batch INAD sono stati fetchati una volta (evita ri-fetch ad ogni tick cron). */
  @Column({ name: 'inad_fetched', type: 'boolean', default: false })
  inadFetched!: boolean;

  /** Chiave = CF fisico, valore = domicilio digitale INAD trovato (solo entry "found"). */
  @Column({ name: 'inad_found_map', type: 'jsonb', default: {} })
  inadFoundMap!: Record<string, string>;

  /** true quando il job App IO (singolo, sull'intero CSV) ha scritto il suo esito finale. */
  @Column({ name: 'app_io_done', type: 'boolean', default: false })
  appIoDone!: boolean;

  @Column({ name: 'app_io_processed_rows', type: 'int', default: 0 })
  appIoProcessedRows!: number;

  @Column({ name: 'app_io_present_count', type: 'int', default: 0 })
  appIoPresentCount!: number;

  @Column({ name: 'app_io_absent_count', type: 'int', default: 0 })
  appIoAbsentCount!: number;

  /** Chiave = CF fisico (16 char), valore = presente su App IO — solo per CF effettivamente verificati. */
  @Column({ name: 'app_io_results', type: 'jsonb', default: {} })
  appIoResults!: Record<string, boolean>;

  @Column({ name: 'registro_imprese_total', type: 'int', default: 0 })
  registroImpreseTotal!: number;

  @Column({ name: 'registro_imprese_done', type: 'int', default: 0 })
  registroImpreseDone!: number;

  @Column({ name: 'registro_imprese_found_count', type: 'int', default: 0 })
  registroImpreseFoundCount!: number;

  /**
   * Chiave = CF/PIVA, valore = PEC trovata o null se non trovata. Scritto
   * SEMPRE con una UPDATE SQL raw che concatena jsonb (mai un
   * read-modify-write) — job PIVA/CF-residuo paralleli sullo stesso
   * DomicileVerificationJob altrimenti perderebbero scritture in race
   * (stesso pattern già in uso su inad_verification_jobs.piva_results).
   */
  @Column({ name: 'registro_imprese_results', type: 'jsonb', default: {} })
  registroImpreseResults!: Record<string, string | null>;

  /** true dopo che il fallback CF-fisici-non-trovati-INAD è stato accodato su Registro Imprese (una sola volta). */
  @Column({ name: 'residual_enqueued', type: 'boolean', default: false })
  residualEnqueued!: boolean;

  @Column({ name: 'result_assenti_csv', type: 'text', nullable: true })
  resultAssentiCsv!: string | null;

  @Column({ name: 'result_app_io_csv', type: 'text', nullable: true })
  resultAppIoCsv!: string | null;

  @Column({ name: 'result_inad_csv', type: 'text', nullable: true })
  resultInadCsv!: string | null;

  @Column({ name: 'result_registro_imprese_csv', type: 'text', nullable: true })
  resultRegistroImpreseCsv!: string | null;

  @Column({ name: 'result_aggregato_csv', type: 'text', nullable: true })
  resultAggregatoCsv!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
```

- [ ] **Step 2: Creare la migration** (droppa le 2 tabelle vecchie, crea la nuova — stesso stile delle migration esistenti, `queryRunner.query` raw)

```ts
// apps/backend/src/database/migrations/1789900000000-CreateDomicileVerificationJobs.ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateDomicileVerificationJobs1789900000000 implements MigrationInterface {
    name = 'CreateDomicileVerificationJobs1789900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "app_io_verification_jobs"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."app_io_verification_jobs_status_enum"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "inad_verification_jobs"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."inad_verification_jobs_status_enum"`);

        await queryRunner.query(`CREATE TYPE "public"."domicile_verification_jobs_status_enum" AS ENUM('queued', 'processing', 'done', 'failed')`);
        await queryRunner.query(`
            CREATE TABLE "domicile_verification_jobs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "status" "public"."domicile_verification_jobs_status_enum" NOT NULL DEFAULT 'queued',
                "total_rows" integer NOT NULL DEFAULT 0,
                "source_csv" text NOT NULL,
                "csv_headers" jsonb NOT NULL,
                "cf_column" character varying(256) NOT NULL,
                "has_headers" boolean NOT NULL DEFAULT true,
                "io_service_id" uuid NOT NULL,
                "cf_fisico_total" integer NOT NULL DEFAULT 0,
                "piva_total" integer NOT NULL DEFAULT 0,
                "inad_batches" jsonb NOT NULL DEFAULT '[]',
                "inad_fetched" boolean NOT NULL DEFAULT false,
                "inad_found_map" jsonb NOT NULL DEFAULT '{}',
                "app_io_done" boolean NOT NULL DEFAULT false,
                "app_io_processed_rows" integer NOT NULL DEFAULT 0,
                "app_io_present_count" integer NOT NULL DEFAULT 0,
                "app_io_absent_count" integer NOT NULL DEFAULT 0,
                "app_io_results" jsonb NOT NULL DEFAULT '{}',
                "registro_imprese_total" integer NOT NULL DEFAULT 0,
                "registro_imprese_done" integer NOT NULL DEFAULT 0,
                "registro_imprese_found_count" integer NOT NULL DEFAULT 0,
                "registro_imprese_results" jsonb NOT NULL DEFAULT '{}',
                "residual_enqueued" boolean NOT NULL DEFAULT false,
                "result_assenti_csv" text,
                "result_app_io_csv" text,
                "result_inad_csv" text,
                "result_registro_imprese_csv" text,
                "result_aggregato_csv" text,
                "error_message" text,
                "created_at" TIMESTAMP NOT NULL DEFAULT now(),
                "completed_at" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_domicile_verification_jobs" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "domicile_verification_jobs"`);
        await queryRunner.query(`DROP TYPE "public"."domicile_verification_jobs_status_enum"`);
        // Nessun ripristino delle 2 tabelle vecchie nel down() — stesso
        // principio già in uso altrove (ALTER TYPE ADD VALUE): un rollback
        // di questa migration non è pensato per riportare indietro dati.
    }
}
```

- [ ] **Step 3: Registrare entità e migration in `database.module.ts`**

Modificare gli import (riga ~14-16):
```ts
import { DomicileVerificationJob } from '../entities/domicile-verification-job.entity.js';
import { EnrichmentJob } from '../entities/enrichment-job.entity.js';
```
(rimuovere le righe `import { AppIoVerificationJob } ...` e `import { InadVerificationJob } ...`)

Aggiungere l'import della migration accanto alle altre (dopo la riga con `AddDownloadEventsRecipientIdIndex1789800000000`):
```ts
import { CreateDomicileVerificationJobs1789900000000 } from './migrations/1789900000000-CreateDomicileVerificationJobs.js';
```

Nell'array `entities:` sostituire `AppIoVerificationJob, InadVerificationJob` con `DomicileVerificationJob` (stessa posizione).

Nell'array `migrations:` aggiungere `CreateDomicileVerificationJobs1789900000000` in coda (dopo `AddDownloadEventsRecipientIdIndex1789800000000`). **Non rimuovere** le migration `CreateAppIoVerificationJobs1784700000000`/`CreateInadVerificationJobs1785200000000`/`AddPivaColumnsToInadVerificationJobs1786800000000` dall'array — la history delle migration non si riscrive mai, il drop delle vecchie tabelle vive nella nuova migration.

- [ ] **Step 4: Registrare l'entità anche in `data-source.ts`** (usato dai comandi CLI `typeorm-ts-node-esm`)

Stessa sostituzione: rimuovere gli import/riferimenti a `AppIoVerificationJob`/`InadVerificationJob`, aggiungere `import { DomicileVerificationJob } from '../entities/domicile-verification-job.entity.js';` e sostituirlo nell'array `entities:`.

- [ ] **Step 5: Verificare la registrazione**

Run: `grep -n "DomicileVerificationJob\|CreateDomicileVerificationJobs1789900000000" apps/backend/src/database/database.module.ts apps/backend/src/database/data-source.ts`
Expected: l'entità compare in entrambi i file, la migration compare (import + array `migrations:`) in `database.module.ts`.

- [ ] **Step 6: Type-check**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore (a questo punto altri file referenziano ancora `AppIoVerificationJob`/`InadVerificationJob` — errori attesi qui, verranno risolti nei Task successivi; se il type-check fallisce SOLO su quei file già noti, procedere; se fallisce sull'entità/migration appena create, fixare prima di continuare).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/entities/domicile-verification-job.entity.ts apps/backend/src/database/migrations/1789900000000-CreateDomicileVerificationJobs.ts apps/backend/src/database/database.module.ts apps/backend/src/database/data-source.ts
git commit -m "feat(domicile-verification): entità e migration DomicileVerificationJob"
```

---

### Task 2: CSV aggregation util (pure, TDD)

**Files:**
- Create: `apps/backend/src/channels/domicile-verification/domicile-verification-csv.util.ts`
- Test: `apps/backend/src/channels/domicile-verification/domicile-verification-csv.util.spec.ts`

**Interfaces:**
- Consumes: `parseCsvContent`, `buildCsvContent` da `../../io-services/csv.util.js` (firme invariate, già esistenti).
- Produces: `buildDomicileVerificationCsvs(input: DomicileVerificationCsvInput): DomicileVerificationCsvResult` — usata da Task 4 (sync service).

- [ ] **Step 1: Scrivere i test (falliranno — il modulo non esiste ancora)**

```ts
// apps/backend/src/channels/domicile-verification/domicile-verification-csv.util.spec.ts
import { buildDomicileVerificationCsvs } from './domicile-verification-csv.util.js';

describe('buildDomicileVerificationCsvs', () => {
  const baseInput = {
    sourceCsv: 'cf,nome\nRSSMRA85M01H501Z,Mario Rossi\nVRDLGI80A01H501W,Luigi Verdi\n12345678901,Acme Srl\n98765432109,Beta Srl\n',
    hasHeaders: true,
    cfColumn: 'cf',
  };

  it('priorità Registro Imprese su INAD per un CF fisico trovato da entrambi', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: { RSSMRA85M01H501Z: 'mario.inad@pec.it' },
      appIoResults: {},
      registroImpreseResults: { RSSMRA85M01H501Z: 'mario.registro@pec.it' },
    });
    expect(result.aggregatoCsv).toContain('mario.registro@pec.it');
    expect(result.aggregatoCsv).not.toContain('mario.inad@pec.it');
    expect(result.inadCsv).toContain('mario.inad@pec.it'); // il tracciato INAD-specifico resta indipendente dalla priorità aggregata
    expect(result.registroImpreseCsv).toContain('mario.registro@pec.it');
  });

  it('CF fisico trovato solo su App IO: aggregato "non attivo" nega, "attivo" per il trovato', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: { RSSMRA85M01H501Z: true, VRDLGI80A01H501W: false },
      registroImpreseResults: {},
    });
    expect(result.appIoCsv).toContain('RSSMRA85M01H501Z');
    expect(result.appIoCsv).not.toContain('VRDLGI80A01H501W');
    expect(result.aggregatoCsv).toMatch(/RSSMRA85M01H501Z,Mario Rossi,,attivo/);
    expect(result.aggregatoCsv).toMatch(/VRDLGI80A01H501W,Luigi Verdi,,non attivo/);
  });

  it('CF fisico senza nessun risultato: finisce in assenti, domicilio vuoto, App IO "non attivo"', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: { RSSMRA85M01H501Z: false, VRDLGI80A01H501W: false },
      registroImpreseResults: {},
    });
    expect(result.assentiCsv).toContain('RSSMRA85M01H501Z');
    expect(result.assentiCsv).toContain('VRDLGI80A01H501W');
  });

  it('PIVA trovata su Registro Imprese: colonna App IO sempre "n.d.", mai in assenti', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: {},
      registroImpreseResults: { '12345678901': 'acme@pec.it' },
    });
    expect(result.registroImpreseCsv).toContain('acme@pec.it');
    expect(result.assentiCsv).not.toContain('12345678901');
    expect(result.aggregatoCsv).toMatch(/12345678901,Acme Srl,acme@pec\.it,n\.d\./);
  });

  it('PIVA non trovata (chiave assente da registroImpreseResults): finisce in assenti', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: {},
      registroImpreseResults: { '12345678901': 'acme@pec.it' }, // 98765432109 mai interrogata/trovata
    });
    expect(result.assentiCsv).toContain('98765432109');
  });

  it('PIVA con esito "non trovata" esplicito (valore null): finisce comunque in assenti', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: {},
      registroImpreseResults: { '98765432109': null },
    });
    expect(result.assentiCsv).toContain('98765432109');
  });

  it('appIoCsv/inadCsv/registroImpreseCsv sono null quando zero risultati (nessuna riga "se almeno un risultato")', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: {},
      registroImpreseResults: {},
    });
    expect(result.appIoCsv).toBeNull();
    expect(result.inadCsv).toBeNull();
    expect(result.registroImpreseCsv).toBeNull();
  });

  it('assentiCsv e aggregatoCsv sono SEMPRE stringhe, anche a zero risultati (tutte le righe assenti)', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: {},
      appIoResults: {},
      registroImpreseResults: {},
    });
    expect(typeof result.assentiCsv).toBe('string');
    expect(typeof result.aggregatoCsv).toBe('string');
    // tutte e 4 le righe del CSV sorgente sono assenti
    expect(result.assentiCsv).toContain('RSSMRA85M01H501Z');
    expect(result.assentiCsv).toContain('VRDLGI80A01H501W');
    expect(result.assentiCsv).toContain('12345678901');
    expect(result.assentiCsv).toContain('98765432109');
  });

  it('aggregatoCsv contiene SEMPRE tutte le righe, indipendentemente dall\'esito', () => {
    const result = buildDomicileVerificationCsvs({
      ...baseInput,
      inadFoundMap: { RSSMRA85M01H501Z: 'mario@pec.it' },
      appIoResults: {},
      registroImpreseResults: { '12345678901': 'acme@pec.it' },
    });
    expect(result.aggregatoCsv).toContain('RSSMRA85M01H501Z');
    expect(result.aggregatoCsv).toContain('VRDLGI80A01H501W');
    expect(result.aggregatoCsv).toContain('12345678901');
    expect(result.aggregatoCsv).toContain('98765432109');
  });
});
```

- [ ] **Step 2: Eseguire i test per verificare il fallimento**

Run: `docker compose exec backend node_modules/.bin/vitest run domicile-verification-csv.util`
Expected: FAIL con `Cannot find module './domicile-verification-csv.util.js'`

- [ ] **Step 3: Implementare la funzione**

```ts
// apps/backend/src/channels/domicile-verification/domicile-verification-csv.util.ts
import { parseCsvContent, buildCsvContent } from '../../io-services/csv.util.js';

export interface DomicileVerificationCsvInput {
  sourceCsv: string;
  hasHeaders: boolean;
  cfColumn: string;
  inadFoundMap: Record<string, string>;
  appIoResults: Record<string, boolean>;
  registroImpreseResults: Record<string, string | null>;
}

export interface DomicileVerificationCsvResult {
  assentiCsv: string;
  appIoCsv: string | null;
  inadCsv: string | null;
  registroImpreseCsv: string | null;
  aggregatoCsv: string;
}

const ADDRESS_COLUMN = 'domicilio_digitale_inad';
const PEC_COLUMN = 'pec_registro_imprese';
const AGGREGATE_DOMICILIO_COLUMN = 'domicilio_digitale';
const AGGREGATE_APPIO_COLUMN = 'app_io';

/**
 * CF fisico = 16 caratteri (nessuna Partita IVA ha questa lunghezza, il
 * formato 11-cifre di isPartitaIva è per costruzione mutuamente esclusivo —
 * nessun controllo aggiuntivo necessario, stesso criterio già in uso in
 * InadVerifyBulkService.createJob).
 */
function isCfFisico(cf: string): boolean {
  return cf.length === 16;
}

export function buildDomicileVerificationCsvs(input: DomicileVerificationCsvInput): DomicileVerificationCsvResult {
  const parsed = parseCsvContent(input.sourceCsv, input.hasHeaders);

  const assentiRows: Record<string, string>[] = [];
  const appIoRows: Record<string, string>[] = [];
  const inadRows: Record<string, string>[] = [];
  const registroImpreseRows: Record<string, string>[] = [];
  const aggregatoRows: Record<string, string>[] = [];

  for (const row of parsed.rows) {
    const cf = (row[input.cfColumn] || '').trim().toUpperCase();
    const cfFisico = isCfFisico(cf);

    const inadAddress = cfFisico ? input.inadFoundMap[cf] : undefined;
    const appIoActive = cfFisico ? input.appIoResults[cf] : undefined;
    const registroPec = input.registroImpreseResults[cf] || undefined;

    const domicilioDigitale = registroPec || inadAddress || '';
    const appIoValue = cfFisico ? (appIoActive ? 'attivo' : 'non attivo') : 'n.d.';

    aggregatoRows.push({ ...row, [AGGREGATE_DOMICILIO_COLUMN]: domicilioDigitale, [AGGREGATE_APPIO_COLUMN]: appIoValue });

    if (inadAddress) inadRows.push({ ...row, [ADDRESS_COLUMN]: inadAddress });
    if (appIoActive) appIoRows.push({ ...row });
    if (registroPec) registroImpreseRows.push({ ...row, [PEC_COLUMN]: registroPec });

    const isAssente = cfFisico ? (!inadAddress && !appIoActive && !registroPec) : !registroPec;
    if (isAssente) assentiRows.push({ ...row });
  }

  return {
    assentiCsv: buildCsvContent(parsed.headers, assentiRows),
    appIoCsv: appIoRows.length > 0 ? buildCsvContent(parsed.headers, appIoRows) : null,
    inadCsv: inadRows.length > 0 ? buildCsvContent([...parsed.headers, ADDRESS_COLUMN], inadRows) : null,
    registroImpreseCsv: registroImpreseRows.length > 0 ? buildCsvContent([...parsed.headers, PEC_COLUMN], registroImpreseRows) : null,
    aggregatoCsv: buildCsvContent([...parsed.headers, AGGREGATE_DOMICILIO_COLUMN, AGGREGATE_APPIO_COLUMN], aggregatoRows),
  };
}
```

- [ ] **Step 4: Eseguire i test per verificare il successo**

Run: `docker compose exec backend node_modules/.bin/vitest run domicile-verification-csv.util`
Expected: PASS (9 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/domicile-verification/domicile-verification-csv.util.ts apps/backend/src/channels/domicile-verification/domicile-verification-csv.util.spec.ts
git commit -m "feat(domicile-verification): util costruzione 5 CSV aggregati"
```

---

### Task 3: `DomicileVerificationService` — createJob/getStatus/getResultCsv/listJobs (TDD)

**Files:**
- Create: `apps/backend/src/channels/domicile-verification/domicile-verification.service.ts`
- Test: `apps/backend/src/channels/domicile-verification/domicile-verification.service.spec.ts`

**Interfaces:**
- Consumes: `DomicileVerificationJob`/`DomicileVerificationJobStatus` (Task 1), `InadService.startBulkExtraction(cfs: string[], practicalReference: string): Promise<{id: string}>` (esistente, invariato), `RegistroImpreseVerifyQueueService.enqueueVerify(jobId: string, identificativo: string): Promise<void>` (esistente, invariato), `Queue<AppIoVerifyBulkJobData>` (BullMQ, esistente — `../../io-services/app-io-verify-bulk-job.types.js`), `parseCsvContent` (`../../io-services/csv.util.js`), `isPartitaIva` (`../tax-id.util.js`).
- Produces: `DomicileVerificationService` con `createJob(params): Promise<CreateDomicileVerificationJobResult>`, `getStatus(jobId): Promise<DomicileVerificationStatus>`, `getResultCsv(jobId, variant): Promise<string>`, `listJobs(): Promise<DomicileVerificationJobSummary[]>` — usato da Task 8 (controller).

- [ ] **Step 1: Scrivere i test**

```ts
// apps/backend/src/channels/domicile-verification/domicile-verification.service.spec.ts
import { DomicileVerificationService } from './domicile-verification.service.js';
import { DomicileVerificationJobStatus } from '../../entities/domicile-verification-job.entity.js';

const mockJobRepo = {
  create: jest.fn((v: any) => v),
  save: jest.fn(async (v: any) => ({ id: 'job-1', ...v })),
  update: jest.fn(),
  findOneBy: jest.fn(),
  find: jest.fn(),
};
const mockIoServiceRepo = { findOneBy: jest.fn() };
const mockInad = { startBulkExtraction: jest.fn() };
const mockRegistroImpreseQueue = { enqueueVerify: jest.fn() };
const mockAppIoQueue = { add: jest.fn() };

describe('DomicileVerificationService.createJob', () => {
  let service: DomicileVerificationService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIoServiceRepo.findOneBy.mockResolvedValue({ id: 'svc-1' });
    service = new DomicileVerificationService(mockJobRepo as any, mockIoServiceRepo as any, mockInad as any, mockRegistroImpreseQueue as any, mockAppIoQueue as any);
  });

  it('smista CF fisici (16 char) su App IO+INAD e Partite IVA (11 cifre) su Registro Imprese', async () => {
    const csv = 'cf\nRRANGL74M28R701V\n12345678901\n98765432109\n';
    mockInad.startBulkExtraction.mockResolvedValue({ id: 'batch-1' });

    const result = await service.createJob({ csvContent: csv, hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1' });

    expect(result.jobId).toBe('job-1');
    expect(mockAppIoQueue.add).toHaveBeenCalledWith('verify', { jobId: 'job-1' }, { jobId: 'job-1' });
    expect(mockInad.startBulkExtraction).toHaveBeenCalledWith(['RRANGL74M28R701V'], 'comunicapa-domicili-job-1');
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', '12345678901');
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', '98765432109');
    expect(mockJobRepo.save).toHaveBeenCalledWith(expect.objectContaining({ cfFisicoTotal: 1, pivaTotal: 2, ioServiceId: 'svc-1' }));
    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', { inadBatches: [{ id: 'batch-1', size: 1, done: false }] });
    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', { status: DomicileVerificationJobStatus.PROCESSING, registroImpreseTotal: 2 });
  });

  it('CSV di sole PIVA: nessun job App IO/INAD accodato', async () => {
    const csv = 'cf\n12345678901\n';

    const result = await service.createJob({ csvContent: csv, hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1' });

    expect(result.jobId).toBe('job-1');
    expect(mockAppIoQueue.add).not.toHaveBeenCalled();
    expect(mockInad.startBulkExtraction).not.toHaveBeenCalled();
    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', '12345678901');
    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', { status: DomicileVerificationJobStatus.PROCESSING, registroImpreseTotal: 1 });
  });

  it('blocca se il servizio App IO non esiste', async () => {
    mockIoServiceRepo.findOneBy.mockResolvedValue(null);

    const result = await service.createJob({ csvContent: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-x' });

    expect(result).toEqual({ blocked: true, message: 'Servizio App IO selezionato non trovato' });
    expect(mockJobRepo.save).not.toHaveBeenCalled();
  });

  it('blocca se non ci sono né CF fisici né Partite IVA validi', async () => {
    const result = await service.createJob({ csvContent: 'cf\nnonvalido\n', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1' });

    expect(result).toEqual({ blocked: true, message: 'Nessun codice fiscale (16 caratteri) o Partita IVA (11 cifre) valido trovato nella colonna selezionata' });
    expect(mockJobRepo.save).not.toHaveBeenCalled();
  });

  it('un fallimento parziale (es. App IO non accodato) non blocca il job: errorMessage riporta il problema', async () => {
    mockAppIoQueue.add.mockRejectedValue(new Error('coda giù'));
    mockInad.startBulkExtraction.mockResolvedValue({ id: 'batch-1' });

    const result = await service.createJob({ csvContent: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1' });

    expect(result.jobId).toBe('job-1');
    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.status === DomicileVerificationJobStatus.PROCESSING);
    expect(call![1].errorMessage).toContain('App IO non accodato');
  });

  it('FAILED immediato se tutti i tentativi di enqueue falliscono', async () => {
    mockAppIoQueue.add.mockRejectedValue(new Error('coda giù'));
    mockInad.startBulkExtraction.mockRejectedValue(new Error('INAD giù'));

    const result = await service.createJob({ csvContent: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1' });

    expect(result.jobId).toBe('job-1');
    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.status === DomicileVerificationJobStatus.FAILED);
    expect(call).toBeDefined();
  });
});

describe('DomicileVerificationService.getResultCsv', () => {
  let service: DomicileVerificationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DomicileVerificationService(mockJobRepo as any, mockIoServiceRepo as any, mockInad as any, mockRegistroImpreseQueue as any, mockAppIoQueue as any);
  });

  it('ritorna il CSV richiesto quando il job è DONE', async () => {
    mockJobRepo.findOneBy.mockResolvedValue({ status: DomicileVerificationJobStatus.DONE, resultAssentiCsv: 'assenti-content' });

    const csv = await service.getResultCsv('job-1', 'assenti');

    expect(csv).toBe('assenti-content');
  });

  it('lancia se il job non è ancora DONE', async () => {
    mockJobRepo.findOneBy.mockResolvedValue({ status: DomicileVerificationJobStatus.PROCESSING });

    await expect(service.getResultCsv('job-1', 'assenti')).rejects.toThrow('Il job di verifica non è ancora completato');
  });

  it('lancia 404 se il CSV richiesto è null (nessun risultato per quella categoria)', async () => {
    mockJobRepo.findOneBy.mockResolvedValue({ status: DomicileVerificationJobStatus.DONE, resultAppIoCsv: null });

    await expect(service.getResultCsv('job-1', 'app-io')).rejects.toThrow('Risultato non disponibile');
  });
});
```

- [ ] **Step 2: Eseguire i test per verificare il fallimento**

Run: `docker compose exec backend node_modules/.bin/vitest run channels/domicile-verification/domicile-verification.service`
Expected: FAIL con `Cannot find module './domicile-verification.service.js'`

- [ ] **Step 3: Implementare il service**

```ts
// apps/backend/src/channels/domicile-verification/domicile-verification.service.ts
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import {
  DomicileVerificationJob,
  DomicileVerificationJobStatus,
  DomicileInadBatch,
} from '../../entities/domicile-verification-job.entity.js';
import { IoServiceConfig } from '../../entities/io-service-config.entity.js';
import { parseCsvContent } from '../../io-services/csv.util.js';
import { APP_IO_VERIFY_BULK_QUEUE, AppIoVerifyBulkJobData } from '../../io-services/app-io-verify-bulk-job.types.js';
import { InadService } from '../inad/inad.service.js';
import { RegistroImpreseVerifyQueueService } from '../registro-imprese/registro-imprese-verify-queue.service.js';
import { isPartitaIva } from '../tax-id.util.js';

const BATCH_SIZE = 1000;
const CF_FISICO_LENGTH = 16;

export interface CreateDomicileVerificationJobParams {
  csvContent: string;
  hasHeaders: boolean;
  cfColumn: string;
  ioServiceId: string;
}

export interface CreateDomicileVerificationJobResult {
  jobId?: string;
  blocked?: boolean;
  message?: string;
}

export interface DomicileVerificationStatus {
  status: DomicileVerificationJobStatus;
  totalRows: number;
  cfFisicoTotal: number;
  pivaTotal: number;
  inadBatchesTotal: number;
  inadBatchesDone: number;
  inadFoundCount: number;
  appIoDone: boolean;
  appIoProcessedRows: number;
  appIoPresentCount: number;
  registroImpreseTotal: number;
  registroImpreseDone: number;
  registroImpreseFoundCount: number;
  errorMessage: string | null;
}

export interface DomicileVerificationJobSummary {
  id: string;
  status: DomicileVerificationJobStatus;
  createdAt: Date;
  totalRows: number;
  cfFisicoTotal: number;
  pivaTotal: number;
}

export type DomicileVerificationCsvVariant = 'assenti' | 'app-io' | 'inad' | 'registro-imprese' | 'aggregato';

const CSV_COLUMN_BY_VARIANT: Record<DomicileVerificationCsvVariant, keyof DomicileVerificationJob> = {
  'assenti': 'resultAssentiCsv',
  'app-io': 'resultAppIoCsv',
  'inad': 'resultInadCsv',
  'registro-imprese': 'resultRegistroImpreseCsv',
  'aggregato': 'resultAggregatoCsv',
};

@Injectable()
export class DomicileVerificationService {
  private readonly logger = new Logger(DomicileVerificationService.name);

  constructor(
    @InjectRepository(DomicileVerificationJob)
    private readonly jobRepo: Repository<DomicileVerificationJob>,
    @InjectRepository(IoServiceConfig)
    private readonly ioServiceRepo: Repository<IoServiceConfig>,
    private readonly inadService: InadService,
    private readonly registroImpreseQueue: RegistroImpreseVerifyQueueService,
    @InjectQueue(APP_IO_VERIFY_BULK_QUEUE)
    private readonly appIoQueue: Queue<AppIoVerifyBulkJobData>,
  ) {}

  async createJob(params: CreateDomicileVerificationJobParams): Promise<CreateDomicileVerificationJobResult> {
    const service = await this.ioServiceRepo.findOneBy({ id: params.ioServiceId });
    if (!service) {
      return { blocked: true, message: 'Servizio App IO selezionato non trovato' };
    }

    const parsed = parseCsvContent(params.csvContent, params.hasHeaders);
    if (parsed.rows.length === 0) {
      return { blocked: true, message: 'Il CSV caricato non contiene righe di dati' };
    }
    if (!parsed.headers.includes(params.cfColumn)) {
      return { blocked: true, message: `Colonna "${params.cfColumn}" non trovata tra le intestazioni del CSV` };
    }

    const rawValues = parsed.rows.map((row) => (row[params.cfColumn] || '').trim().toUpperCase());
    const cfFisici = Array.from(new Set(rawValues.filter((v) => v.length === CF_FISICO_LENGTH)));
    const pive = Array.from(new Set(rawValues.filter((v) => isPartitaIva(v))));
    if (cfFisici.length === 0 && pive.length === 0) {
      return { blocked: true, message: 'Nessun codice fiscale (16 caratteri) o Partita IVA (11 cifre) valido trovato nella colonna selezionata' };
    }

    const job = this.jobRepo.create({
      status: DomicileVerificationJobStatus.QUEUED,
      totalRows: parsed.rows.length,
      sourceCsv: params.csvContent,
      csvHeaders: parsed.headers,
      cfColumn: params.cfColumn,
      hasHeaders: params.hasHeaders,
      ioServiceId: params.ioServiceId,
      cfFisicoTotal: cfFisici.length,
      pivaTotal: pive.length,
      inadBatches: [],
      inadFoundMap: {},
      appIoResults: {},
      registroImpreseResults: {},
      resultAssentiCsv: null,
      resultAppIoCsv: null,
      resultInadCsv: null,
      resultRegistroImpreseCsv: null,
      resultAggregatoCsv: null,
      errorMessage: null,
      completedAt: null,
    });
    const saved = await this.jobRepo.save(job);

    let attempts = 0;
    let succeeded = 0;
    let lastError: any = null;
    const partialFailures: string[] = [];

    if (cfFisici.length > 0) {
      attempts++;
      try {
        await this.appIoQueue.add('verify', { jobId: saved.id }, { jobId: saved.id });
        succeeded++;
      } catch (err: any) {
        lastError = err;
        partialFailures.push(`App IO non accodato: ${err.message}`);
        this.logger.warn(`Job ${saved.id}: enqueue App IO fallito: ${err.message}`);
      }

      const batches: DomicileInadBatch[] = [];
      let chunkIndex = 0;
      for (let i = 0; i < cfFisici.length; i += BATCH_SIZE) {
        chunkIndex++;
        attempts++;
        const chunk = cfFisici.slice(i, i + BATCH_SIZE);
        try {
          const { id } = await this.inadService.startBulkExtraction(chunk, `comunicapa-domicili-${saved.id}`);
          batches.push({ id, size: chunk.length, done: false });
          succeeded++;
        } catch (err: any) {
          lastError = err;
          partialFailures.push(`Batch INAD ${chunkIndex} fallito (${chunk.length} CF): ${err.message}`);
          this.logger.warn(`Job ${saved.id}: startBulkExtraction fallito per un chunk (${chunk.length} CF): ${err.message}`);
        }
      }
      await this.jobRepo.update(saved.id, { inadBatches: batches });
    }

    let pivaSucceeded = 0;
    for (const piva of pive) {
      attempts++;
      try {
        await this.registroImpreseQueue.enqueueVerify(saved.id, piva);
        succeeded++;
        pivaSucceeded++;
      } catch (err: any) {
        lastError = err;
        partialFailures.push(`PIVA ${piva} non accodata: ${err.message}`);
        this.logger.warn(`Job ${saved.id}: enqueueVerify fallito per PIVA ${piva}: ${err.message}`);
      }
    }

    if (attempts > 0 && succeeded === 0) {
      await this.jobRepo.update(saved.id, {
        status: DomicileVerificationJobStatus.FAILED,
        errorMessage: partialFailures.join('; ') || (lastError?.message ?? 'Errore sconosciuto'),
        completedAt: new Date(),
      });
    } else {
      await this.jobRepo.update(saved.id, {
        status: DomicileVerificationJobStatus.PROCESSING,
        registroImpreseTotal: pivaSucceeded,
        ...(partialFailures.length > 0 ? { errorMessage: partialFailures.join('; ') } : {}),
      });
    }

    return { jobId: saved.id };
  }

  async getStatus(jobId: string): Promise<DomicileVerificationStatus> {
    const job = await this.jobRepo.findOneBy({ id: jobId });
    if (!job) throw new NotFoundException(`Job di verifica ${jobId} non trovato`);
    return {
      status: job.status,
      totalRows: job.totalRows,
      cfFisicoTotal: job.cfFisicoTotal,
      pivaTotal: job.pivaTotal,
      inadBatchesTotal: job.inadBatches.length,
      inadBatchesDone: job.inadBatches.filter((b) => b.done).length,
      inadFoundCount: Object.keys(job.inadFoundMap).length,
      appIoDone: job.appIoDone,
      appIoProcessedRows: job.appIoProcessedRows,
      appIoPresentCount: job.appIoPresentCount,
      registroImpreseTotal: job.registroImpreseTotal,
      registroImpreseDone: job.registroImpreseDone,
      registroImpreseFoundCount: job.registroImpreseFoundCount,
      errorMessage: job.errorMessage,
    };
  }

  async listJobs(): Promise<DomicileVerificationJobSummary[]> {
    const jobs = await this.jobRepo.find({ order: { createdAt: 'DESC' }, take: 50 });
    return jobs.map((j) => ({
      id: j.id,
      status: j.status,
      createdAt: j.createdAt,
      totalRows: j.totalRows,
      cfFisicoTotal: j.cfFisicoTotal,
      pivaTotal: j.pivaTotal,
    }));
  }

  async getResultCsv(jobId: string, variant: DomicileVerificationCsvVariant): Promise<string> {
    const job = await this.jobRepo.findOneBy({ id: jobId });
    if (!job) throw new NotFoundException(`Job di verifica ${jobId} non trovato`);
    if (job.status !== DomicileVerificationJobStatus.DONE) {
      throw new BadRequestException('Il job di verifica non è ancora completato');
    }
    const content = job[CSV_COLUMN_BY_VARIANT[variant]] as string | null;
    if (!content) throw new NotFoundException('Risultato non disponibile');
    return content;
  }
}
```

- [ ] **Step 4: Eseguire i test per verificare il successo**

Run: `docker compose exec backend node_modules/.bin/vitest run channels/domicile-verification/domicile-verification.service`
Expected: PASS (9 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/domicile-verification/domicile-verification.service.ts apps/backend/src/channels/domicile-verification/domicile-verification.service.spec.ts
git commit -m "feat(domicile-verification): DomicileVerificationService createJob/status/download"
```

---

### Task 4: Ripuntare `AppIoVerifyBulkProcessor` su `DomicileVerificationJob`

**Files:**
- Modify: `apps/backend/src/io-services/app-io-verify-bulk.processor.ts`
- Modify: `apps/backend/src/io-services/app-io-verify-bulk.processor.spec.ts`

**Interfaces:**
- Consumes: `DomicileVerificationJob`/`DomicileVerificationJobStatus` (Task 1), `IoServicesService.verifyProfile` (esistente, invariato).
- Produces: nessuna nuova interfaccia — stesso `AppIoVerifyBulkProcessor` esportato, comportamento su dominio invariato (classifica presente/assente), ma scrive sui campi `appIo*` di `DomicileVerificationJob` invece che sull'intera riga `AppIoVerificationJob`.

- [ ] **Step 1: Riscrivere lo spec per il nuovo comportamento atteso (fallirà contro il processor attuale)**

```ts
// apps/backend/src/io-services/app-io-verify-bulk.processor.spec.ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppIoVerifyBulkProcessor, isPresentResult } from './app-io-verify-bulk.processor.js';
import { DomicileVerificationJob, DomicileVerificationJobStatus } from '../entities/domicile-verification-job.entity.js';
import { IoServiceConfig } from '../entities/io-service-config.entity.js';
import { IoServicesService } from './io-services.service.js';

describe('isPresentResult', () => {
  it('presente solo se success && active && messaggio non contiene "disabilitati"', () => {
    expect(isPresentResult({ success: true, active: true, message: 'Iscritto ad App IO e messaggi abilitati' })).toBe(true);
    expect(isPresentResult({ success: true, active: true, message: 'Iscritto ma messaggi disabilitati dall\'utente' })).toBe(false);
    expect(isPresentResult({ success: true, active: false, message: 'Cittadino non iscritto' })).toBe(false);
    expect(isPresentResult({ success: false, active: false, message: 'Errore di connessione' })).toBe(false);
  });
});

describe('AppIoVerifyBulkProcessor', () => {
  let processor: AppIoVerifyBulkProcessor;
  const jobRepoMock = { findOneBy: jest.fn(), update: jest.fn() };
  const ioServiceRepoMock = { findOneBy: jest.fn() };
  const ioServicesMock = { verifyProfile: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppIoVerifyBulkProcessor,
        { provide: getRepositoryToken(DomicileVerificationJob), useValue: jobRepoMock },
        { provide: getRepositoryToken(IoServiceConfig), useValue: ioServiceRepoMock },
        { provide: IoServicesService, useValue: ioServicesMock },
      ],
    }).compile();
    processor = moduleRef.get(AppIoVerifyBulkProcessor);
  });

  it('classifica presenti/assenti sui soli CF plausibili (16 char), scrive appIoResults e marca appIoDone', async () => {
    jobRepoMock.findOneBy.mockResolvedValue({
      id: 'job-1',
      sourceCsv: 'cf,nome\nRSSMRA85M01H501Z,Mario Rossi\nAAAAAA,CF Corto\nVRDLGI80A01H501W,Luigi Verdi',
      hasHeaders: true,
      cfColumn: 'cf',
      ioServiceId: 'svc-1',
    });
    ioServiceRepoMock.findOneBy.mockResolvedValue({ id: 'svc-1', apiKeyPrimariaEnc: 'enc:v1:xxx' });
    ioServicesMock.verifyProfile.mockImplementation(async (cf: string) => {
      if (cf === 'RSSMRA85M01H501Z') return { success: true, active: true, message: 'Iscritto ad App IO e messaggi abilitati' };
      return { success: true, active: false, message: 'Cittadino non iscritto ad App IO' };
    });

    await processor.process({ data: { jobId: 'job-1' } } as any);

    expect(ioServicesMock.verifyProfile).toHaveBeenCalledTimes(2); // AAAAAA è CF non plausibile, nessuna chiamata
    expect(ioServicesMock.verifyProfile).toHaveBeenCalledWith('RSSMRA85M01H501Z', 'svc-1');
    expect(ioServicesMock.verifyProfile).toHaveBeenCalledWith('VRDLGI80A01H501W', 'svc-1');

    const doneCall = jobRepoMock.update.mock.calls.find(([, patch]) => patch.appIoDone === true);
    expect(doneCall).toBeDefined();
    const [, patch] = doneCall;
    expect(patch.appIoProcessedRows).toBe(3); // tutte le righe, incluso il CF corto
    expect(patch.appIoPresentCount).toBe(1);
    expect(patch.appIoAbsentCount).toBe(1); // AAAAAA non conta: non era un CF plausibile
    expect(patch.appIoResults).toEqual({ RSSMRA85M01H501Z: true, VRDLGI80A01H501W: false });
  });

  it('marca l\'intero DomicileVerificationJob FAILED se il servizio App IO scelto non esiste più o non ha una chiave configurata', async () => {
    jobRepoMock.findOneBy.mockResolvedValue({
      id: 'job-2',
      sourceCsv: 'cf\nRSSMRA85M01H501Z',
      hasHeaders: true,
      cfColumn: 'cf',
      ioServiceId: 'svc-deleted',
    });
    ioServiceRepoMock.findOneBy.mockResolvedValue(null);

    await processor.process({ data: { jobId: 'job-2' } } as any);

    expect(ioServicesMock.verifyProfile).not.toHaveBeenCalled();
    const failedCall = jobRepoMock.update.mock.calls.find(([, patch]) => patch.status === DomicileVerificationJobStatus.FAILED);
    expect(failedCall).toBeDefined();
    expect(failedCall[1].errorMessage).toContain('svc-deleted');
  });
});
```

- [ ] **Step 2: Eseguire i test per verificare il fallimento**

Run: `docker compose exec backend node_modules/.bin/vitest run app-io-verify-bulk.processor`
Expected: FAIL (il processor attuale scrive ancora `status`/`resultPresentCsv` su `AppIoVerificationJob`, `patch.appIoDone`/`appIoResults` sono `undefined`)

- [ ] **Step 3: Modificare il processor**

```ts
// apps/backend/src/io-services/app-io-verify-bulk.processor.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DomicileVerificationJob, DomicileVerificationJobStatus } from '../entities/domicile-verification-job.entity.js';
import { IoServiceConfig } from '../entities/io-service-config.entity.js';
import { IoServicesService } from './io-services.service.js';
import { parseCsvContent } from './csv.util.js';
import { APP_IO_VERIFY_BULK_QUEUE, AppIoVerifyBulkJobData } from './app-io-verify-bulk-job.types.js';

const PROGRESS_UPDATE_EVERY = 25;
const CONCURRENCY = 5;

/** Stessa convenzione già usata in App.tsx per la verifica singola: un
 * profilo con messaggi disabilitati per questo servizio non è "presente"
 * ai fini di un successivo invio reale. */
export function isPresentResult(result: { success: boolean; active: boolean; message: string }): boolean {
  return result.success && result.active && !result.message.includes('disabilitati');
}

/**
 * Job unico sull'intero CSV del DomicileVerificationJob (App IO non ha un
 * equivalente del batch INAD — un profilo alla volta via verifyProfile) —
 * scrive SOLO i campi app_io_* del job padre, mai lo status complessivo
 * (deciso da DomicileVerificationSyncService in base a tutte e 3 le fonti).
 * Un errore hard (servizio App IO selezionato non trovato/senza chiave) fa
 * fallire l'intero job padre: senza quel servizio non è possibile
 * verificare nessun CF, non ha senso proseguire con le altre fonti.
 */
@Injectable()
@Processor(APP_IO_VERIFY_BULK_QUEUE)
export class AppIoVerifyBulkProcessor extends WorkerHost {
  private readonly logger = new Logger(AppIoVerifyBulkProcessor.name);

  constructor(
    @InjectRepository(DomicileVerificationJob)
    private readonly jobRepo: Repository<DomicileVerificationJob>,
    @InjectRepository(IoServiceConfig)
    private readonly ioServiceRepo: Repository<IoServiceConfig>,
    private readonly ioServices: IoServicesService,
  ) {
    super();
  }

  async process(job: Job<AppIoVerifyBulkJobData>): Promise<void> {
    const { jobId } = job.data;
    const record = await this.jobRepo.findOneBy({ id: jobId });
    if (!record) {
      this.logger.warn(`DomicileVerificationJob ${jobId} non trovato — job App IO scartato`);
      return;
    }

    try {
      const service = await this.ioServiceRepo.findOneBy({ id: record.ioServiceId });
      if (!service || !service.apiKeyPrimariaEnc) {
        throw new Error(`Servizio App IO selezionato (${record.ioServiceId}) non trovato o senza chiave API configurata`);
      }

      const parsed = parseCsvContent(record.sourceCsv, record.hasHeaders);
      const results: Record<string, boolean> = {};
      let processed = 0;
      let present = 0;
      let absent = 0;

      const runRow = async (row: Record<string, string>) => {
        const cf = (row[record.cfColumn] || '').trim().toUpperCase();
        if (cf.length === 16) {
          let isPresent = false;
          try {
            const result = await this.ioServices.verifyProfile(cf, record.ioServiceId);
            isPresent = isPresentResult(result);
          } catch {
            // Errore non gestito da verifyProfile (es. servizio eliminato a
            // metà job): stesso trattamento degli errori di rete, la riga
            // finisce tra gli assenti, il job intero non fallisce per questo.
            isPresent = false;
          }
          results[cf] = isPresent;
          isPresent ? present++ : absent++;
        }
        processed += 1;
        if (processed % PROGRESS_UPDATE_EVERY === 0) {
          await this.jobRepo.update(jobId, { appIoProcessedRows: processed });
        }
      };

      for (let i = 0; i < parsed.rows.length; i += CONCURRENCY) {
        const batch = parsed.rows.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(runRow));
      }

      await this.jobRepo.update(jobId, {
        appIoDone: true,
        appIoProcessedRows: parsed.rows.length,
        appIoPresentCount: present,
        appIoAbsentCount: absent,
        appIoResults: results,
      });
      this.logger.log(`DomicileVerificationJob ${jobId}: App IO completato — ${present} presenti, ${absent} assenti`);
    } catch (err: any) {
      this.logger.error(`DomicileVerificationJob ${jobId}: App IO fallito, job intero marcato FAILED — ${err.message}`);
      await this.jobRepo.update(jobId, {
        status: DomicileVerificationJobStatus.FAILED,
        errorMessage: err.message,
        completedAt: new Date(),
      });
    }
  }
}
```

- [ ] **Step 4: Eseguire i test per verificare il successo**

Run: `docker compose exec backend node_modules/.bin/vitest run app-io-verify-bulk.processor`
Expected: PASS (3 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/io-services/app-io-verify-bulk.processor.ts apps/backend/src/io-services/app-io-verify-bulk.processor.spec.ts
git commit -m "feat(domicile-verification): ripunta AppIoVerifyBulkProcessor su DomicileVerificationJob"
```

---

### Task 5: Ripuntare `RegistroImpreseVerifyProcessor` (branch ad-hoc) su `domicile_verification_jobs`

**Files:**
- Modify: `apps/backend/src/channels/registro-imprese/registro-imprese-verify.processor.ts`
- Modify: `apps/backend/src/channels/registro-imprese/registro-imprese-verify.processor.spec.ts`
- Modify: `apps/backend/src/channels/registro-imprese/registro-imprese.module.ts`

**Interfaces:**
- Consumes: `DomicileVerificationJob` (Task 1, per il repository iniettato — usato solo per `.query()` raw, mai per `.findOneBy`).
- Produces: nessuna nuova interfaccia — stesso `RegistroImpreseVerifyProcessor`, il branch `VERIFY_PIVA_CAMPAIGN_JOB_NAME` (campagne) resta **completamente invariato**.

- [ ] **Step 1: Aggiornare le 3 assertion sul branch ad-hoc nello spec (le altre restano invariate)**

Nel file `registro-imprese-verify.processor.spec.ts`, sostituire le 3 occorrenze che referenziano la tabella/colonne vecchie:

```ts
// riga ~22-25, era: expect.stringContaining('UPDATE inad_verification_jobs')
  it('scrive found:true e la PEC su esito positivo', async () => {
    mockRegistroImprese.dettaglioImpresa.mockResolvedValue({ found: true, raw: '<xml/>', pec: 'acme@pec.it' });

    await processor.process({ name: VERIFY_PIVA_JOB_NAME, data: { jobId: 'job-1', partitaIva: '12345678901' } } as any);

    expect(mockJobRepo.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE domicile_verification_jobs'),
      [JSON.stringify({ '12345678901': 'acme@pec.it' }), 1, 'job-1'],
    );
  });
```

```ts
// riga ~91-93 (test onFailed), era: expect.stringContaining('piva_done = piva_done + 1')
  it('scrive pec:null e incrementa registro_imprese_done quando i tentativi sono esauriti (esito finale)', async () => {
    const job = {
      name: VERIFY_PIVA_JOB_NAME,
      data: { jobId: 'job-1', partitaIva: '12345678901' },
      attemptsMade: 8,
      opts: { attempts: 8 },
    } as any;

    await processor.onFailed(job);

    expect(mockJobRepo.query).toHaveBeenCalledWith(
      expect.stringContaining('registro_imprese_done = registro_imprese_done + 1'),
      [JSON.stringify({ '12345678901': null }), 'job-1'],
    );
    // Non deve toccare registro_imprese_found_count: un esaurimento retry non è mai "trovato".
    const [sql] = mockJobRepo.query.mock.calls[0];
    expect(sql).not.toContain('registro_imprese_found_count');
  });
```

Le altre 2 assertion sul branch ad-hoc (`expect.any(String)`) e tutti i test del branch `VERIFY_PIVA_CAMPAIGN_JOB_NAME` restano identici (non toccano la query raw).

- [ ] **Step 2: Eseguire i test per verificare il fallimento**

Run: `docker compose exec backend node_modules/.bin/vitest run registro-imprese-verify.processor`
Expected: FAIL sulle 2 assertion modificate (il processor scrive ancora `UPDATE inad_verification_jobs`/`piva_done`)

- [ ] **Step 3: Modificare la query raw nel processor**

In `registro-imprese-verify.processor.ts`, sostituire l'import e le 2 query raw (`processAdHocVerify` e `onFailed`):

```ts
import { DomicileVerificationJob } from '../../entities/domicile-verification-job.entity.js';
```
(al posto di `import { InadVerificationJob } from '../../entities/inad-verification-job.entity.js';`)

Nel costruttore: `@InjectRepository(DomicileVerificationJob) private readonly jobRepo: Repository<DomicileVerificationJob>,` (al posto di `InadVerificationJob`).

In `processAdHocVerify`:
```ts
    await this.jobRepo.query(
      `UPDATE domicile_verification_jobs
       SET registro_imprese_results = COALESCE(registro_imprese_results, '{}'::jsonb) || $1::jsonb,
           registro_imprese_done = registro_imprese_done + 1,
           registro_imprese_found_count = registro_imprese_found_count + $2
       WHERE id = $3`,
      [JSON.stringify({ [partitaIva]: pec }), found ? 1 : 0, jobId],
    );
```

In `onFailed`:
```ts
    await this.jobRepo.query(
      `UPDATE domicile_verification_jobs
       SET registro_imprese_results = COALESCE(registro_imprese_results, '{}'::jsonb) || $1::jsonb,
           registro_imprese_done = registro_imprese_done + 1
       WHERE id = $2`,
      [JSON.stringify({ [partitaIva]: null }), jobId],
    );
```

Aggiornare anche i commenti in cima al file che citano `inad_verification_jobs.piva_results`/`piva_done` (sostituire con `domicile_verification_jobs.registro_imprese_results`/`registro_imprese_done`) — stesso significato, riferimento tabella aggiornato.

- [ ] **Step 4: Aggiornare `registro-imprese.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { PdndModule } from '../../pdnd/pdnd.module.js';
import { DomicileVerificationJob } from '../../entities/domicile-verification-job.entity.js';
import { Recipient } from '../../entities/recipient.entity.js';
import { RegistroImpreseService } from './registro-imprese.service.js';
import { RegistroImpreseVerifyQueueService } from './registro-imprese-verify-queue.service.js';
import { RegistroImpreseVerifyProcessor } from './registro-imprese-verify.processor.js';
import { REGISTRO_IMPRESE_QUEUE } from './registro-imprese-job.types.js';

@Module({
  imports: [
    PdndModule,
    TypeOrmModule.forFeature([DomicileVerificationJob, Recipient]),
    BullModule.registerQueue({ name: REGISTRO_IMPRESE_QUEUE }),
  ],
  providers: [RegistroImpreseService, RegistroImpreseVerifyQueueService, RegistroImpreseVerifyProcessor],
  exports: [RegistroImpreseService, RegistroImpreseVerifyQueueService],
})
export class RegistroImpreseModule {}
```

- [ ] **Step 5: Eseguire i test per verificare il successo**

Run: `docker compose exec backend node_modules/.bin/vitest run registro-imprese-verify.processor`
Expected: PASS (tutti i test, branch ad-hoc + branch campagna)

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels/registro-imprese/registro-imprese-verify.processor.ts apps/backend/src/channels/registro-imprese/registro-imprese-verify.processor.spec.ts apps/backend/src/channels/registro-imprese/registro-imprese.module.ts
git commit -m "feat(domicile-verification): ripunta RegistroImpreseVerifyProcessor (ad-hoc) su domicile_verification_jobs"
```

---

### Task 6: `DomicileVerificationSyncService` — orchestrazione cron (TDD)

**Files:**
- Create: `apps/backend/src/channels/domicile-verification/domicile-verification-sync.service.ts`
- Test: `apps/backend/src/channels/domicile-verification/domicile-verification-sync.service.spec.ts`

**Interfaces:**
- Consumes: `DomicileVerificationJob`/`DomicileVerificationJobStatus`/`DomicileInadBatch` (Task 1), `buildDomicileVerificationCsvs` (Task 2), `InadService.getBulkState(id): Promise<'DISPONIBILE'|...>`/`getBulkResult(id): Promise<InadBulkResultItem[]>` (esistenti, invariati), `RegistroImpreseVerifyQueueService.enqueueVerify` (esistente), `parseCsvContent` (`../../io-services/csv.util.js`).
- Produces: `DomicileVerificationSyncService` con `handleCron(): Promise<void>` — cron `*/5 * * * *`, nessun altro modulo lo consuma direttamente.

- [ ] **Step 1: Scrivere i test**

```ts
// apps/backend/src/channels/domicile-verification/domicile-verification-sync.service.spec.ts
import { DomicileVerificationSyncService } from './domicile-verification-sync.service.js';
import { DomicileVerificationJobStatus } from '../../entities/domicile-verification-job.entity.js';

const mockJobRepo = { find: jest.fn(), update: jest.fn() };
const mockInad = { getBulkState: jest.fn(), getBulkResult: jest.fn() };
const mockRegistroImpreseQueue = { enqueueVerify: jest.fn() };

describe('DomicileVerificationSyncService.handleCron', () => {
  let service: DomicileVerificationSyncService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DomicileVerificationSyncService(mockJobRepo as any, mockInad as any, mockRegistroImpreseQueue as any);
  });

  it('non finalizza se i batch INAD non sono ancora tutti pronti', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: DomicileVerificationJobStatus.PROCESSING, createdAt: new Date(),
      inadBatches: [{ id: 'batch-1', size: 1, done: false }], inadFetched: false, inadFoundMap: {},
      cfFisicoTotal: 1, pivaTotal: 0, appIoDone: true, residualEnqueued: false,
      registroImpreseTotal: 0, registroImpreseDone: 0,
      sourceCsv: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf',
    }]);
    mockInad.getBulkState.mockResolvedValue('IN_ELABORAZIONE');

    await service.handleCron();

    expect(mockJobRepo.update).toHaveBeenCalledWith('job-1', expect.objectContaining({
      inadBatches: [{ id: 'batch-1', size: 1, done: false }],
    }));
    expect(mockJobRepo.update).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ status: DomicileVerificationJobStatus.DONE }));
  });

  it('quando INAD è pronto: fetch una volta, accoda il residuo Registro Imprese sui CF fisici non trovati', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: DomicileVerificationJobStatus.PROCESSING, createdAt: new Date(),
      inadBatches: [{ id: 'batch-1', size: 2, done: false }], inadFetched: false, inadFoundMap: {},
      cfFisicoTotal: 2, pivaTotal: 0, appIoDone: true, residualEnqueued: false,
      registroImpreseTotal: 0, registroImpreseDone: 0,
      sourceCsv: 'cf\nRRANGL74M28R701V\nVRDLGI80A01H501W\n', hasHeaders: true, cfColumn: 'cf',
    }]);
    mockInad.getBulkState.mockResolvedValue('DISPONIBILE');
    mockInad.getBulkResult.mockResolvedValue([
      { codiceFiscale: 'RRANGL74M28R701V', since: '2020', digitalAddress: [{ digitalAddress: 'trovato@pec.it', usageInfo: { motivation: 'x', dateEndValidity: '' } }] },
    ]);

    await service.handleCron();

    expect(mockRegistroImpreseQueue.enqueueVerify).toHaveBeenCalledWith('job-1', 'VRDLGI80A01H501W'); // solo il non-trovato
    expect(mockRegistroImpreseQueue.enqueueVerify).not.toHaveBeenCalledWith('job-1', 'RRANGL74M28R701V');
    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.residualEnqueued === true);
    expect(call).toBeDefined();
    expect(call![1].inadFetched).toBe(true);
    expect(call![1].inadFoundMap).toEqual({ RRANGL74M28R701V: 'trovato@pec.it' });
    expect(call![1].registroImpreseTotal).toBe(1);
  });

  it('non ri-fetcha INAD né riaccoda il residuo se già fatto (inadFetched/residualEnqueued già true)', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: DomicileVerificationJobStatus.PROCESSING, createdAt: new Date(),
      inadBatches: [{ id: 'batch-1', size: 1, done: true }], inadFetched: true, inadFoundMap: { RRANGL74M28R701V: 'x@pec.it' },
      cfFisicoTotal: 1, pivaTotal: 0, appIoDone: true, residualEnqueued: true,
      registroImpreseTotal: 0, registroImpreseDone: 0,
      sourceCsv: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf',
    }]);

    await service.handleCron();

    expect(mockInad.getBulkResult).not.toHaveBeenCalled();
    expect(mockRegistroImpreseQueue.enqueueVerify).not.toHaveBeenCalled();
  });

  it('non finalizza se App IO non ha ancora finito', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: DomicileVerificationJobStatus.PROCESSING, createdAt: new Date(),
      inadBatches: [], inadFetched: true, inadFoundMap: {},
      cfFisicoTotal: 0, pivaTotal: 1, appIoDone: false, residualEnqueued: true,
      registroImpreseTotal: 1, registroImpreseDone: 1,
      sourceCsv: 'cf\n12345678901\n', hasHeaders: true, cfColumn: 'cf',
    }]);

    await service.handleCron();

    expect(mockJobRepo.update).not.toHaveBeenCalledWith('job-1', expect.objectContaining({ status: DomicileVerificationJobStatus.DONE }));
  });

  it('finalizza (DONE) quando INAD+App IO+Registro Imprese sono tutti completi, costruendo i 5 CSV', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: DomicileVerificationJobStatus.PROCESSING, createdAt: new Date(),
      inadBatches: [], inadFetched: true, inadFoundMap: { RRANGL74M28R701V: 'inad@pec.it' },
      cfFisicoTotal: 1, pivaTotal: 1, appIoDone: true, residualEnqueued: true,
      registroImpreseTotal: 1, registroImpreseDone: 1,
      registroImpreseResults: { '12345678901': 'registro@pec.it' },
      appIoResults: {},
      sourceCsv: 'cf\nRRANGL74M28R701V\n12345678901\n', hasHeaders: true, cfColumn: 'cf',
    }]);

    await service.handleCron();

    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.status === DomicileVerificationJobStatus.DONE);
    expect(call).toBeDefined();
    const patch = call![1];
    expect(patch.resultAggregatoCsv).toContain('inad@pec.it');
    expect(patch.resultAggregatoCsv).toContain('registro@pec.it');
    expect(patch.resultInadCsv).toContain('inad@pec.it');
    expect(patch.resultRegistroImpreseCsv).toContain('registro@pec.it');
    expect(patch.completedAt).toBeInstanceOf(Date);
  });

  it('marca FAILED un job bloccato in PROCESSING da più di 24h', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: DomicileVerificationJobStatus.PROCESSING, createdAt: new Date(Date.now() - 25 * 3600 * 1000),
      inadBatches: [{ id: 'batch-1', size: 1, done: false }], inadFetched: false, inadFoundMap: {},
      cfFisicoTotal: 1, pivaTotal: 0, appIoDone: false, residualEnqueued: false,
      registroImpreseTotal: 0, registroImpreseDone: 0,
      sourceCsv: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf',
    }]);
    mockInad.getBulkState.mockResolvedValue('IN_ELABORAZIONE');

    await service.handleCron();

    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.status === DomicileVerificationJobStatus.FAILED);
    expect(call).toBeDefined();
    expect(call![1].errorMessage).toContain('24');
  });

  it('un errore imprevisto durante il sync marca il job FAILED (mai un job bloccato senza spiegazione)', async () => {
    mockJobRepo.find.mockResolvedValue([{
      id: 'job-1', status: DomicileVerificationJobStatus.PROCESSING, createdAt: new Date(),
      inadBatches: [{ id: 'batch-1', size: 1, done: false }], inadFetched: false, inadFoundMap: {},
      cfFisicoTotal: 1, pivaTotal: 0, appIoDone: true, residualEnqueued: false,
      registroImpreseTotal: 0, registroImpreseDone: 0,
      sourceCsv: 'cf\nRRANGL74M28R701V\n', hasHeaders: true, cfColumn: 'cf',
    }]);
    mockInad.getBulkState.mockRejectedValue(new Error('INAD giù'));

    await service.handleCron();

    const call = mockJobRepo.update.mock.calls.find(([, patch]: any) => patch.status === DomicileVerificationJobStatus.FAILED);
    expect(call).toBeDefined();
    expect(call![1].errorMessage).toContain('INAD giù');
  });
});
```

- [ ] **Step 2: Eseguire i test per verificare il fallimento**

Run: `docker compose exec backend node_modules/.bin/vitest run domicile-verification-sync.service`
Expected: FAIL con `Cannot find module './domicile-verification-sync.service.js'`

- [ ] **Step 3: Implementare il sync service**

```ts
// apps/backend/src/channels/domicile-verification/domicile-verification-sync.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { DomicileVerificationJob, DomicileVerificationJobStatus } from '../../entities/domicile-verification-job.entity.js';
import { parseCsvContent } from '../../io-services/csv.util.js';
import { InadService } from '../inad/inad.service.js';
import { RegistroImpreseVerifyQueueService } from '../registro-imprese/registro-imprese-verify-queue.service.js';
import { buildDomicileVerificationCsvs } from './domicile-verification-csv.util.js';

const CF_FISICO_LENGTH = 16;

/** Rete di sicurezza: un job bloccato oltre questa soglia (una fonte mai
 * completa per un bug non ancora scoperto) va chiuso esplicitamente FAILED
 * invece di restare in PROCESSING per sempre — stesso principio già in uso
 * su InadVerifyBulkSyncService. */
const STALE_AFTER_HOURS = 24;

/**
 * Poll periodico dei 3 job PROCESSING — un job è completo solo quando TUTTE
 * e 3 le fonti lo sono: INAD (batch pronti + fetch fatto), App IO (job
 * singolo con appIoDone), Registro Imprese (registroImpreseDone >=
 * registroImpreseTotal, MA solo dopo che il residuo sui CF fisici non
 * trovati da INAD è stato accodato — residualEnqueued — altrimenti il gate
 * potrebbe risultare vero prematuramente con registroImpreseTotal ancora
 * al solo conteggio PIVA).
 */
@Injectable()
export class DomicileVerificationSyncService {
  private readonly logger = new Logger(DomicileVerificationSyncService.name);

  constructor(
    @InjectRepository(DomicileVerificationJob)
    private readonly jobRepo: Repository<DomicileVerificationJob>,
    private readonly inadService: InadService,
    private readonly registroImpreseQueue: RegistroImpreseVerifyQueueService,
  ) {}

  @Cron('*/5 * * * *')
  async handleCron(): Promise<void> {
    const jobs = await this.jobRepo.find({ where: { status: DomicileVerificationJobStatus.PROCESSING } });
    for (const job of jobs) {
      try {
        await this.syncOne(job);
      } catch (err) {
        this.logger.warn(`Errore sync DomicileVerificationJob ${job.id}: ${err instanceof Error ? err.message : err}`);
        await this.jobRepo.update(job.id, {
          status: DomicileVerificationJobStatus.FAILED,
          errorMessage: err instanceof Error ? err.message : 'Errore sconosciuto',
          completedAt: new Date(),
        });
      }
    }
  }

  private async syncOne(job: DomicileVerificationJob): Promise<void> {
    const batches = job.inadBatches;
    for (const batch of batches) {
      if (batch.done) continue;
      const state = await this.inadService.getBulkState(batch.id);
      if (state === 'DISPONIBILE') batch.done = true;
    }
    const inadAllReady = batches.every((b) => b.done);

    const patch: Partial<DomicileVerificationJob> = { inadBatches: batches };

    let inadFoundMap = job.inadFoundMap;
    let inadFetched = job.inadFetched;
    if (inadAllReady && !inadFetched) {
      const map: Record<string, string> = {};
      for (const batch of batches) {
        const items = await this.inadService.getBulkResult(batch.id);
        items.forEach((item) => {
          if (!item.digitalAddress || item.digitalAddress.length === 0) return;
          map[item.codiceFiscale.toUpperCase()] = item.digitalAddress.map((a) => a.digitalAddress).join('; ');
        });
      }
      inadFoundMap = map;
      inadFetched = true;
      patch.inadFoundMap = inadFoundMap;
      patch.inadFetched = true;
    }

    let residualEnqueued = job.residualEnqueued;
    let registroImpreseTotal = job.registroImpreseTotal;
    if (inadAllReady && inadFetched && !residualEnqueued) {
      const parsed = parseCsvContent(job.sourceCsv, job.hasHeaders);
      const cfFisici = Array.from(new Set(
        parsed.rows
          .map((row) => (row[job.cfColumn] || '').trim().toUpperCase())
          .filter((cf) => cf.length === CF_FISICO_LENGTH),
      ));
      const residuo = cfFisici.filter((cf) => inadFoundMap[cf] === undefined);
      let enqueued = 0;
      for (const cf of residuo) {
        try {
          await this.registroImpreseQueue.enqueueVerify(job.id, cf);
          enqueued++;
        } catch (err: any) {
          this.logger.warn(`Job ${job.id}: enqueue residuo Registro Imprese fallito per ${cf}: ${err.message}`);
        }
      }
      registroImpreseTotal = job.registroImpreseTotal + enqueued;
      residualEnqueued = true;
      patch.residualEnqueued = true;
      patch.registroImpreseTotal = registroImpreseTotal;
    }

    const appIoReady = job.cfFisicoTotal === 0 || job.appIoDone;
    const registroImpreseReady = residualEnqueued && job.registroImpreseDone >= registroImpreseTotal;
    const complete = inadAllReady && inadFetched && appIoReady && registroImpreseReady;

    if (!complete) {
      const ageHours = (Date.now() - new Date(job.createdAt as any).getTime()) / 3_600_000;
      if (ageHours > STALE_AFTER_HOURS) {
        await this.jobRepo.update(job.id, {
          ...patch,
          status: DomicileVerificationJobStatus.FAILED,
          errorMessage: `Verifica interrotta: non completata entro ${STALE_AFTER_HOURS}h (INAD pronto: ${inadAllReady}, App IO pronto: ${appIoReady}, Registro Imprese ${job.registroImpreseDone}/${registroImpreseTotal}).`,
          completedAt: new Date(),
        });
        this.logger.warn(`DomicileVerificationJob ${job.id} marcato FAILED per stallo (>${STALE_AFTER_HOURS}h in PROCESSING).`);
        return;
      }
      await this.jobRepo.update(job.id, patch);
      return;
    }

    const csvs = buildDomicileVerificationCsvs({
      sourceCsv: job.sourceCsv,
      hasHeaders: job.hasHeaders,
      cfColumn: job.cfColumn,
      inadFoundMap,
      appIoResults: job.appIoResults,
      registroImpreseResults: job.registroImpreseResults,
    });

    await this.jobRepo.update(job.id, {
      ...patch,
      status: DomicileVerificationJobStatus.DONE,
      resultAssentiCsv: csvs.assentiCsv,
      resultAppIoCsv: csvs.appIoCsv,
      resultInadCsv: csvs.inadCsv,
      resultRegistroImpreseCsv: csvs.registroImpreseCsv,
      resultAggregatoCsv: csvs.aggregatoCsv,
      completedAt: new Date(),
    });
    this.logger.log(`DomicileVerificationJob ${job.id} completato`);
  }
}
```

- [ ] **Step 4: Eseguire i test per verificare il successo**

Run: `docker compose exec backend node_modules/.bin/vitest run domicile-verification-sync.service`
Expected: PASS (7 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/domicile-verification/domicile-verification-sync.service.ts apps/backend/src/channels/domicile-verification/domicile-verification-sync.service.spec.ts
git commit -m "feat(domicile-verification): DomicileVerificationSyncService orchestrazione cron"
```

---

### Task 7: `DomicileVerificationRetentionService` + chiave settings (TDD)

**Files:**
- Create: `apps/backend/src/channels/domicile-verification/domicile-verification-retention.service.ts`
- Test: `apps/backend/src/channels/domicile-verification/domicile-verification-retention.service.spec.ts`
- Modify: `apps/backend/src/settings/settings.registry.ts`

**Interfaces:**
- Consumes: `DomicileVerificationJob`/`DomicileVerificationJobStatus` (Task 1), `AppSettingsService.get(key): Promise<SettingValue>` (esistente, invariato).
- Produces: `DomicileVerificationRetentionService` con `runCleanup(): Promise<number>` (chiamato dal cron `handleCron`) — nessun altro consumer.

- [ ] **Step 1: Aggiungere la chiave in `settings.registry.ts`**

Aggiungere accanto a `'enrichment.retentionDays'`:
```ts
  'domicileVerification.retentionDays': { type: 'number', default: 7 },
```

- [ ] **Step 2: Scrivere i test**

```ts
// apps/backend/src/channels/domicile-verification/domicile-verification-retention.service.spec.ts
import { DomicileVerificationJobStatus } from '../../entities/domicile-verification-job.entity.js';
import { DomicileVerificationRetentionService } from './domicile-verification-retention.service.js';

describe('DomicileVerificationRetentionService', () => {
  let repo: any;
  let settings: any;
  let service: DomicileVerificationRetentionService;

  const oldJob = { id: 'old-job', status: DomicileVerificationJobStatus.DONE, createdAt: new Date(Date.now() - 10 * 24 * 3600 * 1000) };

  beforeEach(() => {
    repo = { find: jest.fn(async () => [oldJob]), delete: jest.fn(async () => undefined) };
    settings = { get: jest.fn(async () => 7) };
    service = new DomicileVerificationRetentionService(repo, settings);
  });

  it('elimina job più vecchi della retention configurata', async () => {
    const removed = await service.runCleanup();

    expect(removed).toBe(1);
    expect(repo.delete).toHaveBeenCalledWith('old-job');
    expect(settings.get).toHaveBeenCalledWith('domicileVerification.retentionDays');
  });

  it('la query filtra su createdAt < cutoff e status terminale (QUEUED/DONE/FAILED, mai PROCESSING)', async () => {
    await service.runCleanup();

    const where = repo.find.mock.calls[0][0].where;
    expect(where.status._value).toEqual(expect.arrayContaining([
      DomicileVerificationJobStatus.QUEUED,
      DomicileVerificationJobStatus.DONE,
      DomicileVerificationJobStatus.FAILED,
    ]));
    expect(where.status._value).not.toContain(DomicileVerificationJobStatus.PROCESSING);
  });

  it('nessun job da eliminare: ritorna 0, nessuna delete chiamata', async () => {
    repo.find.mockResolvedValue([]);

    const removed = await service.runCleanup();

    expect(removed).toBe(0);
    expect(repo.delete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Eseguire i test per verificare il fallimento**

Run: `docker compose exec backend node_modules/.bin/vitest run domicile-verification-retention.service`
Expected: FAIL con `Cannot find module './domicile-verification-retention.service.js'`

- [ ] **Step 4: Implementare il service** (nessun file su disco da ripulire — a differenza di Arricchimento Tracciati, i CSV vivono in colonna `text`)

```ts
// apps/backend/src/channels/domicile-verification/domicile-verification-retention.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { DomicileVerificationJob, DomicileVerificationJobStatus } from '../../entities/domicile-verification-job.entity.js';
import { AppSettingsService } from '../../settings/app-settings.service.js';

@Injectable()
export class DomicileVerificationRetentionService {
  private readonly logger = new Logger(DomicileVerificationRetentionService.name);

  constructor(
    @InjectRepository(DomicileVerificationJob)
    private readonly jobRepo: Repository<DomicileVerificationJob>,
    private readonly settings: AppSettingsService,
  ) {}

  @Cron('0 4 * * *')
  async handleCron(): Promise<void> {
    await this.runCleanup();
  }

  async runCleanup(): Promise<number> {
    const days = Number(await this.settings.get('domicileVerification.retentionDays'));
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);

    const expired = await this.jobRepo.find({
      where: {
        createdAt: LessThan(cutoff),
        // PROCESSING escluso: mai cancellare un job in corso
        status: In([DomicileVerificationJobStatus.QUEUED, DomicileVerificationJobStatus.DONE, DomicileVerificationJobStatus.FAILED]),
      },
      take: 200,
    });

    let removed = 0;
    for (const job of expired) {
      await this.jobRepo.delete(job.id);
      removed++;
    }
    if (removed > 0) this.logger.log(`Retention verifica domicili: ${removed} job eliminati`);
    return removed;
  }
}
```

- [ ] **Step 5: Eseguire i test per verificare il successo**

Run: `docker compose exec backend node_modules/.bin/vitest run domicile-verification-retention.service`
Expected: PASS (3 test)

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels/domicile-verification/domicile-verification-retention.service.ts apps/backend/src/channels/domicile-verification/domicile-verification-retention.service.spec.ts apps/backend/src/settings/settings.registry.ts
git commit -m "feat(domicile-verification): retention 7gg (domicileVerification.retentionDays)"
```

---

### Task 8: `DomicileVerificationController` + DTO + upload chunked

**Files:**
- Create: `apps/backend/src/channels/domicile-verification/dto/domicile-verification.dto.ts`
- Create: `apps/backend/src/channels/domicile-verification/domicile-verification.controller.ts`

**Interfaces:**
- Consumes: `DomicileVerificationService` (Task 3, tutti i metodi), `initChunkedUpload`/`safeChunkUploadDir`/`isValidChunkIndex`/`assembleChunkedUpload`/`cleanupChunkedUpload`/`MAX_CHUNK_SIZE_BYTES` (`../../campaigns/chunked-upload.util.js`, esistenti, invariati).
- Produces: route `admin/domicile-verification/*` — usate dal frontend (Task 10/11).

Nessun test dedicato per questo controller: il pattern chunked-upload (`destination`/`filename` di multer con `safeChunkUploadDir`/`isValidChunkIndex`) è copiato 1:1 da `InadVerifyController`/`IoServicesController` — la protezione path-traversal è già coperta da `chunked-upload.util.spec.ts` (funzioni condivise) e da due integration spec rappresentativi esistenti (`campaigns-uploads-path-traversal.integration.spec.ts`, `external-api-http-status.integration.spec.ts`) — stessa motivazione già documentata nel commento di `inad-verify-chunk-upload.integration.spec.ts` (rimosso al Task 9): ripetere un quarto boot Nest+supertest sullo stesso identico codice non aggiunge copertura.

- [ ] **Step 1: DTO**

```ts
// apps/backend/src/channels/domicile-verification/dto/domicile-verification.dto.ts
import { IsBoolean, IsString, IsUUID, MinLength } from 'class-validator';

export class VerifyDomicileBulkCompleteDto {
  @IsBoolean()
  hasHeaders!: boolean;

  @IsString() @MinLength(1)
  cfColumn!: string;

  @IsUUID()
  ioServiceId!: string;
}
```

- [ ] **Step 2: Controller**

```ts
// apps/backend/src/channels/domicile-verification/domicile-verification.controller.ts
import { BadRequestException, Body, Controller, Get, Param, ParseUUIDPipe, Post, Res, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { DomicileVerificationService, DomicileVerificationCsvVariant } from './domicile-verification.service.js';
import { VerifyDomicileBulkCompleteDto } from './dto/domicile-verification.dto.js';
import { initChunkedUpload, safeChunkUploadDir, isValidChunkIndex, assembleChunkedUpload, cleanupChunkedUpload, MAX_CHUNK_SIZE_BYTES } from '../../campaigns/chunked-upload.util.js';

const FILENAME_BY_VARIANT: Record<DomicileVerificationCsvVariant, string> = {
  'assenti': 'assenti',
  'app-io': 'app_io',
  'inad': 'inad',
  'registro-imprese': 'registro_imprese',
  'aggregato': 'aggregato',
};

@Controller('admin/domicile-verification')
export class DomicileVerificationController {
  constructor(private readonly svc: DomicileVerificationService) {}

  @Post('verify/upload/init')
  @Roles('user', 'admin')
  initUpload(@Body() body: { filename?: string; totalChunks?: number }): { uploadId: string } {
    const filename = body.filename?.trim();
    const totalChunks = Number(body.totalChunks);
    if (!filename || !Number.isInteger(totalChunks) || totalChunks < 1) {
      throw new BadRequestException('filename e totalChunks (intero >= 1) richiesti');
    }
    return { uploadId: initChunkedUpload(filename, totalChunks) };
  }

  @Post('verify/upload/chunk/:uploadId/:index')
  @Roles('user', 'admin')
  @UseInterceptors(
    FileInterceptor('chunk', {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const dir = safeChunkUploadDir(req.params['uploadId']);
          if (!dir || !fs.existsSync(dir)) {
            cb(new BadRequestException('Sessione di upload non trovata o scaduta'), '');
            return;
          }
          cb(null, dir);
        },
        filename: (req, _file, cb) => {
          const index = req.params['index'];
          if (!isValidChunkIndex(index)) {
            cb(new BadRequestException('index non valido'), '');
            return;
          }
          cb(null, `${index}.part`);
        },
      }),
      limits: { fileSize: MAX_CHUNK_SIZE_BYTES },
    }),
  )
  uploadChunk(): { ok: true } {
    return { ok: true };
  }

  @Post('verify/upload/complete/:uploadId')
  @Roles('user', 'admin')
  async completeUpload(
    @Param('uploadId') uploadId: string,
    @Body() body: VerifyDomicileBulkCompleteDto,
  ) {
    try {
      const { path } = await assembleChunkedUpload(uploadId);
      const csvContent = await fs.promises.readFile(path, 'utf-8');
      return await this.svc.createJob({
        csvContent,
        hasHeaders: body.hasHeaders,
        cfColumn: body.cfColumn,
        ioServiceId: body.ioServiceId,
      });
    } catch (err: any) {
      return { blocked: true, message: err?.message ?? 'Errore durante il riassemblaggio del CSV' };
    } finally {
      cleanupChunkedUpload(uploadId);
    }
  }

  @Get('jobs')
  @Roles('user', 'admin')
  listJobs() {
    return this.svc.listJobs().then((jobs) => ({ jobs }));
  }

  @Get('jobs/:id')
  @Roles('user', 'admin')
  getStatus(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getStatus(id);
  }

  @Get('jobs/:id/assenti.csv')
  @Roles('user', 'admin')
  async downloadAssenti(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    await this.sendCsv(id, 'assenti', res);
  }

  @Get('jobs/:id/app-io.csv')
  @Roles('user', 'admin')
  async downloadAppIo(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    await this.sendCsv(id, 'app-io', res);
  }

  @Get('jobs/:id/inad.csv')
  @Roles('user', 'admin')
  async downloadInad(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    await this.sendCsv(id, 'inad', res);
  }

  @Get('jobs/:id/registro-imprese.csv')
  @Roles('user', 'admin')
  async downloadRegistroImprese(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    await this.sendCsv(id, 'registro-imprese', res);
  }

  @Get('jobs/:id/aggregato.csv')
  @Roles('user', 'admin')
  async downloadAggregato(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    await this.sendCsv(id, 'aggregato', res);
  }

  private async sendCsv(id: string, variant: DomicileVerificationCsvVariant, res: Response): Promise<void> {
    const content = await this.svc.getResultCsv(id, variant);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="verifica_domicili_${FILENAME_BY_VARIANT[variant]}_${id.slice(0, 8)}.csv"`);
    res.send(content);
  }
}
```

- [ ] **Step 3: Type-check**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun nuovo errore introdotto da questi 2 file (errori residui sui vecchi `AppIoVerifyBulkService`/`InadVerifyBulkService` ancora attesi fino al Task 9).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/channels/domicile-verification/dto/domicile-verification.dto.ts apps/backend/src/channels/domicile-verification/domicile-verification.controller.ts
git commit -m "feat(domicile-verification): controller REST admin/domicile-verification"
```

---

### Task 9: `DomicileVerificationModule` + wiring + rimozione dei 2 pannelli vecchi

**Files:**
- Create: `apps/backend/src/channels/domicile-verification/domicile-verification.module.ts`
- Modify: `apps/backend/src/app.module.ts`
- Modify: `apps/backend/src/io-services/io-services.module.ts`
- Modify: `apps/backend/src/io-services/io-services.controller.ts`
- Modify: `apps/backend/src/channels/inad/inad.module.ts`
- Modify: `apps/backend/src/channels/inad/inad-verify.controller.ts`
- Delete: `apps/backend/src/io-services/app-io-verify-bulk.service.ts`
- Delete: `apps/backend/src/io-services/app-io-verify-bulk.service.spec.ts`
- Delete: `apps/backend/src/entities/app-io-verification-job.entity.ts`
- Delete: `apps/backend/src/channels/inad/inad-verify-bulk.service.ts`
- Delete: `apps/backend/src/channels/inad/inad-verify-bulk.service.spec.ts`
- Delete: `apps/backend/src/channels/inad/inad-verify-bulk-sync.service.ts`
- Delete: `apps/backend/src/channels/inad/inad-verify-bulk-sync.service.spec.ts`
- Delete: `apps/backend/src/channels/inad/inad-verify-chunk-upload.integration.spec.ts`
- Delete: `apps/backend/src/entities/inad-verification-job.entity.ts`

**Interfaces:**
- Consumes: tutto quanto prodotto nei Task 1-8.
- Produces: `DomicileVerificationModule` importato in `AppModule` — nessun altro modulo lo consuma.

- [ ] **Step 1: Creare `domicile-verification.module.ts`**

```ts
// apps/backend/src/channels/domicile-verification/domicile-verification.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { DomicileVerificationJob } from '../../entities/domicile-verification-job.entity.js';
import { IoServiceConfig } from '../../entities/io-service-config.entity.js';
import { InadModule } from '../inad/inad.module.js';
import { RegistroImpreseModule } from '../registro-imprese/registro-imprese.module.js';
import { DomicileVerificationService } from './domicile-verification.service.js';
import { DomicileVerificationSyncService } from './domicile-verification-sync.service.js';
import { DomicileVerificationRetentionService } from './domicile-verification-retention.service.js';
import { DomicileVerificationController } from './domicile-verification.controller.js';
import { AppIoVerifyBulkProcessor } from '../../io-services/app-io-verify-bulk.processor.js';
import { APP_IO_VERIFY_BULK_QUEUE } from '../../io-services/app-io-verify-bulk-job.types.js';

@Module({
  imports: [
    InadModule,
    RegistroImpreseModule,
    // IoServicesService è @Global() (IoServicesModule) — non serve importare
    // quel modulo esplicitamente, stesso pattern già in uso per AppIoStrategy.
    // IoServiceConfig invece NON è esportato da IoServicesModule (solo il
    // service lo è) — va ri-registrato qui per il repository diretto usato
    // da AppIoVerifyBulkProcessor.
    TypeOrmModule.forFeature([DomicileVerificationJob, IoServiceConfig]),
    BullModule.registerQueue({ name: APP_IO_VERIFY_BULK_QUEUE }),
  ],
  controllers: [DomicileVerificationController],
  providers: [
    DomicileVerificationService,
    DomicileVerificationSyncService,
    DomicileVerificationRetentionService,
    AppIoVerifyBulkProcessor,
  ],
})
export class DomicileVerificationModule {}
```

- [ ] **Step 2: Registrare in `app.module.ts`**

Aggiungere l'import (dopo `EnrichmentModule`):
```ts
import { DomicileVerificationModule } from './channels/domicile-verification/domicile-verification.module.js';
```
E nell'array `imports:`, dopo `EnrichmentModule,`:
```ts
    DomicileVerificationModule,
```

- [ ] **Step 3: Snellire `io-services.module.ts`** (rimuove `AppIoVerificationJob`, `AppIoVerifyBulkService`, `AppIoVerifyBulkProcessor` — quest'ultimo si sposta in `DomicileVerificationModule`, la coda si registra lì)

```ts
// apps/backend/src/io-services/io-services.module.ts
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IoServiceConfig } from '../entities/io-service-config.entity.js';
import { IoServicesService } from './io-services.service.js';
import { IoServicesController } from './io-services.controller.js';

// @Global(): AppIoStrategy (in ChannelModule) inietta IoServicesService senza importare
// esplicitamente questo modulo — stesso pattern di MailConfigsModule.
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([IoServiceConfig])],
  controllers: [IoServicesController],
  providers: [IoServicesService],
  exports: [IoServicesService],
})
export class IoServicesModule {}
```

- [ ] **Step 4: Snellire `io-services.controller.ts`** (rimuove le route `verify-bulk/*` e la dipendenza `AppIoVerifyBulkService`)

```ts
// apps/backend/src/io-services/io-services.controller.ts
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { IoServicesService } from './io-services.service.js';
import { CreateIoServiceDto, UpdateIoServiceDto, TestIoServiceDto } from './dto/io-service.dto.js';

@Controller('admin/io-services')
export class IoServicesController {
  constructor(private readonly svc: IoServicesService) {}

  @Get()
  @Roles('user', 'admin')
  list() {
    return this.svc.listMasked().then((configs) => ({ configs }));
  }

  @Post()
  @Roles('admin')
  create(@Body() dto: CreateIoServiceDto) {
    return this.svc.create(dto);
  }

  @Put(':id')
  @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateIoServiceDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(id);
  }

  @Patch(':id/default')
  @Roles('admin')
  setDefault(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.setDefault(id);
  }

  @Post(':id/test')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  test(@Param('id', ParseUUIDPipe) id: string, @Body() body: TestIoServiceDto) {
    return this.svc.test(id, body.codiceFiscale);
  }

  @Post('verify-profile')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  verifyProfile(@Body() body: { codiceFiscale: string }) {
    return this.svc.verifyProfile(body.codiceFiscale);
  }
}
```

Nota: `VerifyBulkCompleteDto` resta dichiarato in `dto/io-service.dto.ts` ma diventa inutilizzato — rimuoverne l'export da quel file se non referenziato altrove (`grep -rn "VerifyBulkCompleteDto" apps/backend/src` prima di rimuoverlo, per sicurezza).

- [ ] **Step 5: Snellire `inad.module.ts`**

```ts
// apps/backend/src/channels/inad/inad.module.ts
import { Module } from '@nestjs/common';
import { PdndModule } from '../../pdnd/pdnd.module.js';
import { InadService } from './inad.service.js';
import { InadVerifyController } from './inad-verify.controller.js';

@Module({
  imports: [PdndModule],
  controllers: [InadVerifyController],
  providers: [InadService],
  exports: [InadService],
})
export class InadModule {}
```

- [ ] **Step 6: Snellire `inad-verify.controller.ts`** (resta solo `verify-single`)

```ts
// apps/backend/src/channels/inad/inad-verify.controller.ts
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { InadService } from './inad.service.js';
import { VerifyInadSingleDto } from './dto/inad-verify.dto.js';

@Controller('admin/inad-verify')
export class InadVerifyController {
  constructor(private readonly inadService: InadService) {}

  @Post('verify-single')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  async verifySingle(@Body() body: VerifyInadSingleDto) {
    const cf = body.codiceFiscale.toUpperCase().trim();
    try {
      const result = await this.inadService.extractDigitalAddress(cf);
      if (!result.found) {
        return { success: true, found: false, message: 'Nessun domicilio digitale trovato su INAD per questo codice fiscale' };
      }
      return {
        success: true,
        found: true,
        message: 'Domicilio digitale trovato su INAD',
        digitalAddress: result.data?.digitalAddress ?? [],
      };
    } catch (err: any) {
      return { success: false, found: false, message: `Errore verifica INAD: ${err.message}` };
    }
  }
}
```

Nota: `VerifyInadBulkCompleteDto` in `dto/inad-verify.dto.ts` diventa inutilizzato — stesso controllo di sicurezza (`grep -rn "VerifyInadBulkCompleteDto"`) prima di rimuoverlo dal file DTO.

- [ ] **Step 7: Eliminare i file obsoleti**

```bash
git rm apps/backend/src/io-services/app-io-verify-bulk.service.ts apps/backend/src/io-services/app-io-verify-bulk.service.spec.ts apps/backend/src/entities/app-io-verification-job.entity.ts apps/backend/src/channels/inad/inad-verify-bulk.service.ts apps/backend/src/channels/inad/inad-verify-bulk.service.spec.ts apps/backend/src/channels/inad/inad-verify-bulk-sync.service.ts apps/backend/src/channels/inad/inad-verify-bulk-sync.service.spec.ts apps/backend/src/channels/inad/inad-verify-chunk-upload.integration.spec.ts apps/backend/src/entities/inad-verification-job.entity.ts
```

(rimozione di `inad-verify-chunk-upload.integration.spec.ts`: copriva un pattern path-traversal già dimostrato altrove — `campaigns-uploads-path-traversal.integration.spec.ts`/`external-api-http-status.integration.spec.ts` — su un controller che dopo questo task non ha più route di upload da proteggere)

- [ ] **Step 8: Rimuovere i DTO inutilizzati se confermati orfani**

Run: `grep -rn "VerifyBulkCompleteDto\b" apps/backend/src | grep -v io-service.dto.ts`
Se nessun risultato, rimuovere la classe `VerifyBulkCompleteDto` da `apps/backend/src/io-services/dto/io-service.dto.ts` (e l'import `IsUUID` se rimasto inutilizzato).

Run: `grep -rn "VerifyInadBulkCompleteDto\b" apps/backend/src | grep -v inad-verify.dto.ts`
Se nessun risultato, rimuovere la classe `VerifyInadBulkCompleteDto` da `apps/backend/src/channels/inad/dto/inad-verify.dto.ts`.

- [ ] **Step 9: Type-check completo**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

Run: `docker compose exec backend node_modules/.bin/tsc -p tsconfig.spec.json --noEmit`
Expected: nessun errore (copre anche gli `*.spec.ts`, incluso l'eventuale spec residuo che referenzia entità rimosse).

- [ ] **Step 10: Suite completa**

Run: `docker compose exec backend node_modules/.bin/vitest run`
Expected: stesso failure set noto della baseline (`app.controller.spec.ts`/`isLdapMock`) — nessun nuovo fallimento.

- [ ] **Step 11: Rebuild e verifica avvio reale (dev)**

```bash
docker compose up -d --build backend
docker compose logs backend --tail 50
```
Expected: nessun crash-loop, nessun `MODULE_NOT_FOUND`/`UnknownDependenciesException`, migration `CreateDomicileVerificationJobs1789900000000` eseguita nei log (se il DB dev gira senza `synchronize`; con `synchronize` attivo in dev verificare comunque che il servizio parta pulito).

- [ ] **Step 12: Commit**

```bash
git add apps/backend/src/channels/domicile-verification/domicile-verification.module.ts apps/backend/src/app.module.ts apps/backend/src/io-services/io-services.module.ts apps/backend/src/io-services/io-services.controller.ts apps/backend/src/channels/inad/inad.module.ts apps/backend/src/channels/inad/inad-verify.controller.ts apps/backend/src/io-services/dto/io-service.dto.ts apps/backend/src/channels/inad/dto/inad-verify.dto.ts
git commit -m "feat(domicile-verification): wiring modulo, rimozione pannelli App IO/INAD massivi separati"
```

---

### Task 10: Frontend — stato e handler unificati

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `uploadFileInChunks` (già esistente, `App.tsx:1089`), `apiFetch`/`ApiAuthError` (già esistenti), endpoint `admin/domicile-verification/*` (Task 8/9).
- Produces: stato React (`domicileVerif*`) e handler consumati dal JSX del Task 11.

- [ ] **Step 1: Sostituire i due blocchi di stato con un unico blocco unificato**

**Attenzione: NON è un intervallo contiguo.** Tra i due blocchi da rimuovere (`verificaBulkFile`...`verificaBulkSubmitError`, righe ~1592-1607, e `verificaInadBulkFile`...`verificaInadBulkSubmitError`, righe ~1695-1710) vive la sezione "Cerca Domicilio" (`domicilioCf`...`domicilioImpresaResult`, righe ~1609-1694) — quella sezione **resta identica, non va toccata**. Sono quindi 2 edit distinti:

1. Rimuovere il blocco `verificaBulkFile`...`verificaBulkSubmitError` (righe ~1592-1607)
2. Rimuovere il blocco `verificaInadBulkFile`...`verificaInadBulkSubmitError` (righe ~1695-1710)

Inserire il blocco unificato sottostante in uno dei due punti (es. dove viveva il primo blocco rimosso):

```tsx
  interface DomicileVerificationStatus {
    status: 'queued' | 'processing' | 'done' | 'failed';
    totalRows: number;
    cfFisicoTotal: number;
    pivaTotal: number;
    inadBatchesTotal: number;
    inadBatchesDone: number;
    inadFoundCount: number;
    appIoDone: boolean;
    appIoProcessedRows: number;
    appIoPresentCount: number;
    registroImpreseTotal: number;
    registroImpreseDone: number;
    registroImpreseFoundCount: number;
    errorMessage: string | null;
  }
  interface DomicileVerificationJobSummary {
    id: string;
    status: 'queued' | 'processing' | 'done' | 'failed';
    createdAt: string;
    totalRows: number;
    cfFisicoTotal: number;
    pivaTotal: number;
  }

  const [domicileVerifFile, setDomicileVerifFile] = useState<File | null>(null);
  const [domicileVerifHasHeaders, setDomicileVerifHasHeaders] = useState(true);
  const [domicileVerifHeaders, setDomicileVerifHeaders] = useState<string[]>([]);
  const [domicileVerifCfColumn, setDomicileVerifCfColumn] = useState('');
  const [domicileVerifServiceId, setDomicileVerifServiceId] = useState('');
  const [domicileVerifJobId, setDomicileVerifJobId] = useState<string | null>(null);
  const [domicileVerifStatus, setDomicileVerifStatus] = useState<DomicileVerificationStatus | null>(null);
  const [domicileVerifSubmitting, setDomicileVerifSubmitting] = useState(false);
  const [domicileVerifSubmitError, setDomicileVerifSubmitError] = useState<string | null>(null);
  const [domicileVerifJobs, setDomicileVerifJobs] = useState<DomicileVerificationJobSummary[]>([]);
  const [domicileVerifJobsLoading, setDomicileVerifJobsLoading] = useState(false);
```

Nota: la sezione `domicilioCf`/`domicilioResult`/... (Verifica Anagrafica singola, righe 1610-1694) resta **invariata** — riguarda "Cerca Domicilio", non i pannelli massivi.

- [ ] **Step 2: Sostituire gli handler** (righe 3280-3600 circa: da `parseVerificaBulkHeaders` a `handleVerificaInadBulkReset`) con gli handler unificati

```tsx
  const parseDomicileVerifHeaders = (file: File, hasHeaders: boolean) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (!text) return;
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
      if (lines.length === 0) { setDomicileVerifHeaders([]); return; }
      const parseCsvLineLocal = (line: string) => {
        const result: string[] = [];
        let current = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          if (char === '"') inQuotes = !inQuotes;
          else if ((char === ',' || char === ';') && !inQuotes) { result.push(current.trim()); current = ''; }
          else current += char;
        }
        result.push(current.trim());
        return result.map(col => col.replace(/^"(.*)"$/, '$1'));
      };
      const firstLineCols = parseCsvLineLocal(lines[0]);
      const headers = hasHeaders ? firstLineCols : firstLineCols.map((_, idx) => `Colonna ${idx + 1}`);
      setDomicileVerifHeaders(headers);
      const guessed = headers.find(h => ['codicefiscale', 'cf'].includes(h.toLowerCase().replace(/[\s_-]/g, '')));
      setDomicileVerifCfColumn(guessed || '');
    };
    reader.readAsText(file);
  };

  const handleDomicileVerifFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDomicileVerifFile(file);
    setDomicileVerifJobId(null);
    setDomicileVerifStatus(null);
    setDomicileVerifSubmitError(null);
    parseDomicileVerifHeaders(file, domicileVerifHasHeaders);
  };

  const handleDomicileVerifSubmit = async () => {
    if (!domicileVerifFile || !domicileVerifCfColumn || !domicileVerifServiceId) return;
    setDomicileVerifSubmitting(true);
    setDomicileVerifSubmitError(null);
    try {
      const data = await uploadFileInChunks(
        `${ADMIN_API_BASE}/domicile-verification/verify/upload`,
        token!,
        domicileVerifFile,
        domicileVerifFile.name,
        () => {},
        undefined,
        {
          hasHeaders: domicileVerifHasHeaders,
          cfColumn: domicileVerifCfColumn,
          ioServiceId: domicileVerifServiceId,
        },
      );
      if (data.blocked) {
        setDomicileVerifSubmitError(data.message || 'Richiesta bloccata');
        return;
      }
      setDomicileVerifJobId(data.jobId);
      setDomicileVerifStatus({
        status: 'queued', totalRows: 0, cfFisicoTotal: 0, pivaTotal: 0,
        inadBatchesTotal: 0, inadBatchesDone: 0, inadFoundCount: 0,
        appIoDone: false, appIoProcessedRows: 0, appIoPresentCount: 0,
        registroImpreseTotal: 0, registroImpreseDone: 0, registroImpreseFoundCount: 0,
        errorMessage: null,
      });
      fetchDomicileVerifJobs();
    } catch (err: any) {
      setDomicileVerifSubmitError(err.message || 'Errore di connessione');
    } finally {
      setDomicileVerifSubmitting(false);
    }
  };

  useEffect(() => {
    if (!domicileVerifJobId) return;
    if (domicileVerifStatus?.status === 'done' || domicileVerifStatus?.status === 'failed') return;
    const timer = setInterval(async () => {
      try {
        const res = await apiFetch(`/domicile-verification/jobs/${domicileVerifJobId}`);
        const data = await res.json();
        setDomicileVerifStatus(data);
        if (data.status === 'done' || data.status === 'failed') fetchDomicileVerifJobs();
      } catch {
        // errore transitorio di polling: riprova al giro successivo
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [domicileVerifJobId, domicileVerifStatus?.status]);

  const fetchDomicileVerifJobs = async () => {
    setDomicileVerifJobsLoading(true);
    try {
      const res = await apiFetch('/domicile-verification/jobs');
      const data = await res.json();
      setDomicileVerifJobs(data.jobs || []);
    } catch {
      // storico non critico: silenzioso, l'operatore può comunque lanciare una nuova verifica
    } finally {
      setDomicileVerifJobsLoading(false);
    }
  };

  const handleDomicileVerifOpenJob = async (jobId: string) => {
    setDomicileVerifJobId(jobId);
    setDomicileVerifSubmitError(null);
    try {
      const res = await apiFetch(`/domicile-verification/jobs/${jobId}`);
      const data = await res.json();
      setDomicileVerifStatus(data);
    } catch (err: any) {
      setDomicileVerifSubmitError(err.message || 'Errore nel recupero dello stato del job');
    }
  };

  const handleDomicileVerifDownload = async (variant: 'assenti' | 'app-io' | 'inad' | 'registro-imprese' | 'aggregato') => {
    if (!domicileVerifJobId) return;
    try {
      const res = await apiFetch(`/domicile-verification/jobs/${domicileVerifJobId}/${variant}.csv`);
      if (!res.ok) { alert('Errore durante il download'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `verifica_domicili_${variant}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch {
      alert('Errore durante il download');
    }
  };

  const handleDomicileVerifReset = () => {
    setDomicileVerifFile(null);
    setDomicileVerifHeaders([]);
    setDomicileVerifCfColumn('');
    setDomicileVerifJobId(null);
    setDomicileVerifStatus(null);
    setDomicileVerifSubmitError(null);
  };
```

`runCercaDomicilio`/`runCercaDomicilioAnagrafica`/`runCercaDomicilioImpresa` (righe 3382-3482) restano **invariati**, sono nel mezzo del blocco rimosso — spostarli prima o dopo il blocco sostituito senza modificarli.

- [ ] **Step 3: Caricare lo storico all'ingresso nella vista** — verrà collegato al `view` nel Task 11 (nessuna azione qui, solo verificare che `fetchDomicileVerifJobs` sia già definita e referenziabile).

- [ ] **Step 4: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: errori residui solo sul JSX non ancora aggiornato (Task 11, che referenzia ancora `verificaBulk*`/`verificaInadBulk*` rimossi) — se compaiono errori sugli handler appena scritti, fixarli prima di proseguire.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(domicile-verification): stato e handler frontend unificati"
```

---

### Task 11: Frontend — pannello JSX unificato + navigazione

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: stato/handler del Task 10, `SearchableSelect` (esistente), `ioServices` (stato esistente, lista servizi App IO), icone già importate (`UserCheck`, `History`, `Contact`, `Building2`, `FileSpreadsheet`, `Loader2`, `Play`, `RotateCcw`).

- [ ] **Step 1: Aggiornare l'union type di `view`** (riga 1516)

Sostituire `'verifica-appio' | 'verifica-inad'` con `'verifica-domicili'`:
```tsx
  const [view, setView] = useState<'dashboard' | 'invio-massivo' | 'invio-massivo-wizard' | 'statistiche' | 'notifiche-ricerca' | 'cerca-domicilio' | 'verifica-domicili' | 'template-dashboard' | 'impostazioni' | 'campaign-detail' | 'audit-logs' | 'arricchimento' | 'guida'>('dashboard');
```

- [ ] **Step 2: Sostituire i 2 elementi di navigazione** (righe 9649-9664) con un unico elemento, che carica lo storico all'apertura

```tsx
          <a
            className={`bo-nav-item ${view === 'verifica-domicili' ? 'is-active' : ''}`}
            href="#"
            onClick={(e) => { e.preventDefault(); setView('verifica-domicili'); fetchDomicileVerifJobs(); }}
          >
            <UserCheck />
            <span>Verifica Domicili Digitali</span>
          </a>
```

- [ ] **Step 3: Sostituire i 2 blocchi `{view === 'verifica-appio' && ...}` / `{view === 'verifica-inad' && ...}`** (righe 14362-14594) con un unico pannello

```tsx
          {view === 'verifica-domicili' && (
            <div style={{ maxWidth: '900px', margin: '0 auto' }}>
              <h3 className="h5 fw-bold text-dark mb-3">
                <UserCheck className="me-2" size={16} />Verifica Domicili Digitali
              </h3>

              <div className="card shadow-sm p-4 mb-4">
                <p className="small text-muted mb-3">
                  Carica un CSV con un elenco di codici fiscali e/o partite IVA: la verifica gira in background (può richiedere diversi minuti su elenchi ampi — INAD batcha fino a 10 minuti) e resta in coda fino a 7 giorni, ritrovabile dallo storico qui sotto anche dopo aver chiuso la pagina. Verifica CF fisici su INAD e App IO; Registro Imprese subito per le Partite IVA e come fallback sui CF fisici che INAD non trova. Per una verifica puntuale su un singolo codice fiscale, usa "Verifica Anagrafica" nel menu.
                </p>

                {!domicileVerifJobId && (
                  <>
                    <div className="mb-3">
                      <label className="form-label small fw-bold">Servizio App IO da usare per la verifica</label>
                      <SearchableSelect
                        className="form-select form-select-sm"
                        value={domicileVerifServiceId}
                        onChange={setDomicileVerifServiceId}
                        placeholder="-- Seleziona Servizio App IO --"
                        options={ioServices.map(s => ({ value: s.id, label: s.nome, isDefault: s.isDefault }))}
                      />
                      <div className="form-text small text-muted">
                        Richiesto anche per un CSV di sole Partite IVA (App IO non verrà comunque interrogato su quelle righe).
                      </div>
                    </div>

                    <div className="mb-3">
                      <div className="form-check form-check-inline">
                        <input className="form-check-input" type="checkbox" id="domicileVerifHasHeaders" checked={domicileVerifHasHeaders}
                          onChange={e => {
                            setDomicileVerifHasHeaders(e.target.checked);
                            if (domicileVerifFile) parseDomicileVerifHeaders(domicileVerifFile, e.target.checked);
                          }} />
                        <label className="form-check-label small" htmlFor="domicileVerifHasHeaders">Il file ha una riga di intestazione</label>
                      </div>
                    </div>

                    <div className="mb-3">
                      <label className="form-label small fw-bold">File CSV</label>
                      <input type="file" accept=".csv" className="form-control form-control-sm" onChange={handleDomicileVerifFileChange} />
                    </div>

                    {domicileVerifHeaders.length > 0 && (
                      <div className="mb-3">
                        <label className="form-label small fw-bold">Colonna Codice Fiscale / Partita IVA</label>
                        <select className="form-select form-select-sm" value={domicileVerifCfColumn} onChange={e => setDomicileVerifCfColumn(e.target.value)}>
                          <option value="">— seleziona —</option>
                          {domicileVerifHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                        </select>
                      </div>
                    )}

                    {domicileVerifSubmitError && (
                      <div className="alert alert-danger small">{domicileVerifSubmitError}</div>
                    )}

                    <button
                      className="btn btn-primary btn-sm"
                      type="button"
                      onClick={handleDomicileVerifSubmit}
                      disabled={domicileVerifSubmitting || !domicileVerifFile || !domicileVerifCfColumn || !domicileVerifServiceId}
                    >
                      {domicileVerifSubmitting ? (
                        <><Loader2 className="icon-spin me-1" size={16} />Avvio...</>
                      ) : (
                        <><Play className="me-1" size={16} />Avvia verifica</>
                      )}
                    </button>
                  </>
                )}

                {domicileVerifJobId && domicileVerifStatus && (
                  <div>
                    {domicileVerifStatus.status !== 'failed' && domicileVerifStatus.errorMessage && (
                      <div className="alert alert-warning small">Attenzione: {domicileVerifStatus.errorMessage}</div>
                    )}

                    {(domicileVerifStatus.status === 'queued' || domicileVerifStatus.status === 'processing') && (
                      <div className="mb-3">
                        <p className="small text-muted mb-2">
                          {domicileVerifStatus.totalRows} righe totali — {domicileVerifStatus.cfFisicoTotal} CF fisici, {domicileVerifStatus.pivaTotal} Partite IVA.
                        </p>
                        {domicileVerifStatus.cfFisicoTotal > 0 && (
                          <>
                            <p className="small text-muted mb-1">INAD: {domicileVerifStatus.inadBatchesDone} / {domicileVerifStatus.inadBatchesTotal || '…'} batch completati</p>
                            <div className="progress mb-2" style={{ height: '8px' }}>
                              <div className="progress-bar" style={{ width: domicileVerifStatus.inadBatchesTotal > 0 ? `${Math.round((domicileVerifStatus.inadBatchesDone / domicileVerifStatus.inadBatchesTotal) * 100)}%` : '5%' }} />
                            </div>
                            <p className="small text-muted mb-1">App IO: {domicileVerifStatus.appIoProcessedRows} / {domicileVerifStatus.totalRows} righe processate</p>
                            <div className="progress mb-2" style={{ height: '8px' }}>
                              <div className="progress-bar" style={{ width: domicileVerifStatus.totalRows > 0 ? `${Math.round((domicileVerifStatus.appIoProcessedRows / domicileVerifStatus.totalRows) * 100)}%` : '5%' }} />
                            </div>
                          </>
                        )}
                        {domicileVerifStatus.registroImpreseTotal > 0 && (
                          <>
                            <p className="small text-muted mb-1">Registro Imprese: {domicileVerifStatus.registroImpreseDone} / {domicileVerifStatus.registroImpreseTotal} verificate</p>
                            <div className="progress mb-2" style={{ height: '8px' }}>
                              <div className="progress-bar" style={{ width: `${Math.round((domicileVerifStatus.registroImpreseDone / domicileVerifStatus.registroImpreseTotal) * 100)}%` }} />
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    {domicileVerifStatus.status === 'done' && (
                      <>
                        <div className="alert alert-success small">
                          Verifica completata: <strong>{domicileVerifStatus.inadFoundCount}</strong> trovati su INAD, <strong>{domicileVerifStatus.appIoPresentCount}</strong> presenti su App IO, <strong>{domicileVerifStatus.registroImpreseFoundCount}</strong> trovati su Registro Imprese.
                        </div>
                        <div className="d-flex gap-2 mb-3 flex-wrap">
                          <button className="btn btn-sm btn-outline-primary" onClick={() => handleDomicileVerifDownload('aggregato')}>
                            <FileSpreadsheet className="me-1" size={16} />Scarica aggregato
                          </button>
                          <button className="btn btn-sm btn-outline-secondary" onClick={() => handleDomicileVerifDownload('assenti')}>
                            <FileSpreadsheet className="me-1" size={16} />Scarica assenti
                          </button>
                          {domicileVerifStatus.appIoPresentCount > 0 && (
                            <button className="btn btn-sm btn-outline-success" onClick={() => handleDomicileVerifDownload('app-io')}>
                              <FileSpreadsheet className="me-1" size={16} />Scarica App IO
                            </button>
                          )}
                          {domicileVerifStatus.inadFoundCount > 0 && (
                            <button className="btn btn-sm btn-outline-success" onClick={() => handleDomicileVerifDownload('inad')}>
                              <FileSpreadsheet className="me-1" size={16} />Scarica INAD
                            </button>
                          )}
                          {domicileVerifStatus.registroImpreseFoundCount > 0 && (
                            <button className="btn btn-sm btn-outline-success" onClick={() => handleDomicileVerifDownload('registro-imprese')}>
                              <FileSpreadsheet className="me-1" size={16} />Scarica Registro Imprese
                            </button>
                          )}
                        </div>
                      </>
                    )}

                    {domicileVerifStatus.status === 'failed' && (
                      <div className="alert alert-danger small">
                        Verifica fallita: {domicileVerifStatus.errorMessage || 'errore sconosciuto'}
                      </div>
                    )}

                    {(domicileVerifStatus.status === 'done' || domicileVerifStatus.status === 'failed') && (
                      <button className="btn btn-sm btn-outline-primary" onClick={handleDomicileVerifReset}>
                        <RotateCcw className="me-1" size={16} />Nuova verifica
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="card shadow-sm p-4">
                <h4 className="h6 fw-bold text-dark mb-3">
                  <History className="me-2" size={16} />Storico verifiche
                </h4>
                {domicileVerifJobsLoading && domicileVerifJobs.length === 0 && (
                  <p className="small text-muted mb-0"><Loader2 className="icon-spin me-1" size={14} />Caricamento…</p>
                )}
                {!domicileVerifJobsLoading && domicileVerifJobs.length === 0 && (
                  <p className="small text-muted mb-0">Nessuna verifica ancora eseguita.</p>
                )}
                {domicileVerifJobs.length > 0 && (
                  <div className="table-responsive">
                    <table className="table table-sm">
                      <thead>
                        <tr>
                          <th>Data</th>
                          <th>Stato</th>
                          <th>Righe</th>
                          <th>CF fisici</th>
                          <th>Partite IVA</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {domicileVerifJobs.map(job => (
                          <tr key={job.id}>
                            <td className="small">{new Date(job.createdAt).toLocaleString('it-IT')}</td>
                            <td className="small">{job.status}</td>
                            <td className="small">{job.totalRows}</td>
                            <td className="small">{job.cfFisicoTotal}</td>
                            <td className="small">{job.pivaTotal}</td>
                            <td>
                              <button className="btn btn-sm btn-outline-secondary" onClick={() => handleDomicileVerifOpenJob(job.id)}>
                                Apri
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
```

- [ ] **Step 4: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 5: Verifica manuale in browser (dev)**

```bash
docker compose up -d --build frontend-admin backend
```
Aprire `http://localhost:3000`, login admin/admin (mock LDAP dev), voce sidebar "Verifica Domicili Digitali": caricare un CSV misto CF fisici + PIVA reali (o di test), avviare la verifica, verificare che appaia nello Storico, ricaricare la pagina e riaprire il job dallo storico, attendere il completamento e scaricare i CSV disponibili.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(domicile-verification): pannello unificato Verifica Domicili Digitali + storico job"
```

---

## Note finali

- Nessun task tocca `campaigns.service.ts`/`InadCheckSyncService`/`VERIFY_PIVA_CAMPAIGN_JOB_NAME` — il flusso INAD al lancio di una campagna massiva resta invariato.
- Dopo il Task 9, eseguire una volta la suite E2E manuale descritta nella spec (CSV misto contro INAD/App IO/Registro Imprese reali — DB dev ha già le credenziali funzionanti) prima di considerare il lavoro concluso.
- Aggiornare `docs/superpowers/specs/2026-09-22-domicile-verification-design.md` solo se l'implementazione scopre un caso non previsto dal design — altrimenti la spec resta la fonte di verità as-is.
