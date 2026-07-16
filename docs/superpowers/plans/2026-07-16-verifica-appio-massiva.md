# Verifica App IO massiva da CSV — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Estendere la pagina "Verifica App IO" con una modalità massiva: upload CSV, verifica asincrona (BullMQ) di migliaia di CF su un servizio App IO scelto esplicitamente, download di due CSV output (stesse colonne dell'originale) con i presenti (App IO attivo + messaggi abilitati per quel servizio) e gli assenti (tutto il resto).

**Architecture:** Nuova entity `AppIoVerificationJob` + coda BullMQ dedicata (`app-io-verify-bulk`, un solo job per upload, non uno per riga) processata da un worker che itera le righe con concorrenza limitata chiamando `IoServicesService.verifyProfile` esteso con `ioServiceId` esplicito (nessun fallback silenzioso al servizio predefinito). Frontend fa polling dello stato del job e propone il download dei CSV a job completato.

**Tech Stack:** NestJS 10, TypeORM 0.3, BullMQ (`@nestjs/bullmq`), React 19 (frontend-admin), Jest.

## Global Constraints

- Spec di riferimento: `docs/superpowers/specs/2026-07-16-verifica-appio-massiva-design.md`.
- Split presenti/assenti: presente **solo se** `active === true` **e** `message` NON contiene `'disabilitati'` (stessa convenzione già usata in `App.tsx` per la verifica singola — non introdurre un nuovo meccanismo di discriminazione).
- I due CSV di output mantengono esattamente le stesse colonne/ordine del CSV sorgente, nessuna colonna aggiuntiva.
- Servizio App IO per la verifica bulk selezionato esplicitamente (mai il default silenzioso): se l'id passato non esiste, la verifica di quella riga fallisce esplicitamente, non ripiega sul servizio predefinito.
- Nessuna richiesta HTTP sincrona che processi tutte le righe: sempre job asincrono + polling (gotcha proxy esterno ~1MB e timeout su richieste bulk sequenziali, vedi CLAUDE.md).
- Riuso pattern esistenti nel repo: parser CSV custom (non introdurre librerie nuove tipo papaparse), pattern `{ blocked: true, message }` per errori "previsti" invece di eccezioni non-2xx, pattern `@Processor`/`WorkerHost` già usato in `protocollazione.processor.ts`, pattern download blob già usato per i report CSV esistenti in `App.tsx`.
- Backend: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2 <pattern>` per i test, `docker compose exec backend node_modules/.bin/tsc --noEmit` per il type-check.
- Frontend: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` per il type-check (nessuna suite di test automatica lato frontend in questo repo).

---

### Task 1: Parser/serializer CSV backend condiviso

**Files:**
- Create: `apps/backend/src/io-services/csv.util.ts`
- Test: `apps/backend/src/io-services/csv.util.spec.ts`

**Interfaces:**
- Produces: `parseCsvContent(content: string, hasHeaders: boolean): { headers: string[]; rows: Record<string, string>[] }`, `buildCsvContent(headers: string[], rows: Record<string, string>[]): string`. Usati da Task 4 (validazione upload) e Task 5 (processor).

- [ ] **Step 1: Scrivi il test che fallisce**

```typescript
// apps/backend/src/io-services/csv.util.spec.ts
import { parseCsvContent, buildCsvContent } from './csv.util';

describe('csv.util', () => {
  describe('parseCsvContent', () => {
    it('usa la prima riga come intestazione quando hasHeaders=true', () => {
      const csv = 'cf,nome\nRSSMRA85M01H501Z,Mario Rossi\nVRDLGI80A01H501W,Luigi Verdi';
      const result = parseCsvContent(csv, true);
      expect(result.headers).toEqual(['cf', 'nome']);
      expect(result.rows).toEqual([
        { cf: 'RSSMRA85M01H501Z', nome: 'Mario Rossi' },
        { cf: 'VRDLGI80A01H501W', nome: 'Luigi Verdi' },
      ]);
    });

    it('genera intestazioni "Colonna N" quando hasHeaders=false', () => {
      const csv = 'RSSMRA85M01H501Z,Mario Rossi';
      const result = parseCsvContent(csv, false);
      expect(result.headers).toEqual(['Colonna 1', 'Colonna 2']);
      expect(result.rows).toEqual([{ 'Colonna 1': 'RSSMRA85M01H501Z', 'Colonna 2': 'Mario Rossi' }]);
    });

    it('gestisce separatore punto e virgola e valori quotati con virgola interna', () => {
      const csv = 'cf;nome\nRSSMRA85M01H501Z;"Rossi, Mario"';
      const result = parseCsvContent(csv, true);
      expect(result.rows).toEqual([{ cf: 'RSSMRA85M01H501Z', nome: 'Rossi, Mario' }]);
    });

    it('ignora righe vuote e ritorna rows vuoto per CSV vuoto', () => {
      expect(parseCsvContent('', true)).toEqual({ headers: [], rows: [] });
      expect(parseCsvContent('cf\n\n\n', true)).toEqual({ headers: ['cf'], rows: [] });
    });
  });

  describe('buildCsvContent', () => {
    it('quota ogni cella, mantiene ordine colonne ed esclude BOM dal confronto testuale', () => {
      const csv = buildCsvContent(['cf', 'nome'], [{ cf: 'RSSMRA85M01H501Z', nome: 'Rossi "Il Grande"' }]);
      expect(csv.replace(/^﻿/, '')).toBe('"cf","nome"\n"RSSMRA85M01H501Z","Rossi ""Il Grande"""');
    });

    it('antepone BOM UTF-8', () => {
      const csv = buildCsvContent(['cf'], []);
      expect(csv.charCodeAt(0)).toBe(0xFEFF);
    });
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest csv.util --maxWorkers=2`
Expected: FAIL — `Cannot find module './csv.util'`

- [ ] **Step 3: Implementa**

```typescript
// apps/backend/src/io-services/csv.util.ts
export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if ((char === ',' || char === ';') && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result.map((col) => col.replace(/^"(.*)"$/, '$1'));
}

export function parseCsvContent(content: string, hasHeaders: boolean): ParsedCsv {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  let headers: string[];
  let dataLines: string[];
  if (hasHeaders) {
    headers = parseCsvLine(lines[0]);
    dataLines = lines.slice(1);
  } else {
    const firstLineCols = parseCsvLine(lines[0]);
    headers = firstLineCols.map((_, idx) => `Colonna ${idx + 1}`);
    dataLines = lines;
  }

  const rows = dataLines.map((line) => {
    const cols = parseCsvLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx] || '';
    });
    return obj;
  });

  return { headers, rows };
}

export function buildCsvContent(headers: string[], rows: Record<string, string>[]): string {
  const escapeCell = (val: string) => `"${String(val ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.map(escapeCell).join(',')];
  rows.forEach((row) => {
    lines.push(headers.map((h) => escapeCell(row[h] || '')).join(','));
  });
  return '﻿' + lines.join('\n');
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest csv.util --maxWorkers=2`
Expected: PASS (7 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/io-services/csv.util.ts apps/backend/src/io-services/csv.util.spec.ts
git commit -m "feat(backend): parser/serializer CSV per verifica App IO massiva"
```

---

### Task 2: Entity `AppIoVerificationJob` + migration

**Files:**
- Create: `apps/backend/src/entities/app-io-verification-job.entity.ts`
- Create: `apps/backend/src/database/migrations/1784700000000-CreateAppIoVerificationJobs.ts`
- Modify: `apps/backend/src/database/database.module.ts`

**Interfaces:**
- Produces: entity `AppIoVerificationJob` con enum `AppIoVerificationJobStatus` (`QUEUED='queued'`, `PROCESSING='processing'`, `DONE='done'`, `FAILED='failed'`), colonne come da spec. Usata da Task 4 (service) e Task 5 (processor).

- [ ] **Step 1: Crea l'entity**

```typescript
// apps/backend/src/entities/app-io-verification-job.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum AppIoVerificationJobStatus {
  QUEUED = 'queued',
  PROCESSING = 'processing',
  DONE = 'done',
  FAILED = 'failed',
}

@Entity('app_io_verification_jobs')
export class AppIoVerificationJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    type: 'enum',
    enum: AppIoVerificationJobStatus,
    default: AppIoVerificationJobStatus.QUEUED,
  })
  status!: AppIoVerificationJobStatus;

  @Column({ name: 'total_rows', type: 'int', default: 0 })
  totalRows!: number;

  @Column({ name: 'processed_rows', type: 'int', default: 0 })
  processedRows!: number;

  @Column({ name: 'present_count', type: 'int', default: 0 })
  presentCount!: number;

  @Column({ name: 'absent_count', type: 'int', default: 0 })
  absentCount!: number;

  /** Contenuto raw del CSV caricato, riparsato dal processor all'avvio del job. */
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

  @Column({ name: 'result_present_csv', type: 'text', nullable: true })
  resultPresentCsv!: string | null;

  @Column({ name: 'result_absent_csv', type: 'text', nullable: true })
  resultAbsentCsv!: string | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
```

- [ ] **Step 2: Crea la migration**

```typescript
// apps/backend/src/database/migrations/1784700000000-CreateAppIoVerificationJobs.ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAppIoVerificationJobs1784700000000 implements MigrationInterface {
    name = 'CreateAppIoVerificationJobs1784700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."app_io_verification_jobs_status_enum" AS ENUM('queued', 'processing', 'done', 'failed')`);
        await queryRunner.query(`
            CREATE TABLE "app_io_verification_jobs" (
                "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "status" "public"."app_io_verification_jobs_status_enum" NOT NULL DEFAULT 'queued',
                "total_rows" integer NOT NULL DEFAULT 0,
                "processed_rows" integer NOT NULL DEFAULT 0,
                "present_count" integer NOT NULL DEFAULT 0,
                "absent_count" integer NOT NULL DEFAULT 0,
                "source_csv" text NOT NULL,
                "csv_headers" jsonb NOT NULL,
                "cf_column" character varying(256) NOT NULL,
                "has_headers" boolean NOT NULL DEFAULT true,
                "io_service_id" uuid NOT NULL,
                "result_present_csv" text,
                "result_absent_csv" text,
                "error_message" text,
                "created_at" TIMESTAMP NOT NULL DEFAULT now(),
                "completed_at" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "PK_app_io_verification_jobs" PRIMARY KEY ("id")
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "app_io_verification_jobs"`);
        await queryRunner.query(`DROP TYPE "public"."app_io_verification_jobs_status_enum"`);
    }
}
```

- [ ] **Step 3: Registra entity e migration in `database.module.ts`**

In `apps/backend/src/database/database.module.ts`, aggiungi gli import in fondo al blocco import esistente e aggiorna `entities`/`migrations`:

```typescript
import { AppIoVerificationJob } from '../entities/app-io-verification-job.entity';
import { CreateAppIoVerificationJobs1784700000000 } from './migrations/1784700000000-CreateAppIoVerificationJobs';
```

```typescript
entities: [Campaign, Recipient, NotificationAttempt, AppSetting, MailServerConfig, IoServiceConfig, Template, DownloadEvent, AuditLog, PostalProviderConfig, AppIoVerificationJob],
// ...
migrations: [InitialSchema1783023440824, AddMailServerConfigs1783071728873, AddIoServiceConfigs1783092759564, AddTemplates1783109448492, FixRecipientCampaignJoin1783148719725, AddDownloadEvents1783200000000, FixRecipientAttemptJoin1783358259000, AddCancelledStatus1783426587867, CreateAuditLogs1783500000000, RenamePdndSettingsKeys1783600000000, AddSendStatusColumns1783700000000, AddProtocolColumns1783800000000, AddUploadedDocumentsColumn1784100000000, AddPostalStatusColumns1784200000000, CreatePostalProviderConfigs1784300000000, SeedStandardTemplates1784400000000, AddSendStatusHistoryColumns1784500000000, AddPostalStatusHistoryColumn1784600000000, CreateAppIoVerificationJobs1784700000000],
```

- [ ] **Step 4: Verifica compilazione e migration su DB temporaneo**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

Run (procedura standard del progetto, DB temporaneo):
```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_test;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_test" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d migration_test -c "\d app_io_verification_jobs"
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_test;"
```
Expected: la migration gira senza errori, `\d app_io_verification_jobs` mostra le colonne attese.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/entities/app-io-verification-job.entity.ts apps/backend/src/database/migrations/1784700000000-CreateAppIoVerificationJobs.ts apps/backend/src/database/database.module.ts
git commit -m "feat(backend): entity e migration AppIoVerificationJob"
```

---

### Task 3: `IoServicesService.verifyProfile` con servizio esplicito (no fallback silenzioso)

**Files:**
- Modify: `apps/backend/src/io-services/io-services.service.ts:100-132`
- Test: `apps/backend/src/io-services/io-services.service.spec.ts`

**Interfaces:**
- Consumes: `IoServiceConfig` repo (già iniettato nel service), `decryptValue` (già importato).
- Produces: `verifyProfile(codiceFiscale: string, ioServiceId?: string): Promise<{ success: boolean; active: boolean; message: string }>` — comportamento invariato senza secondo argomento (usa `resolveApiKey()`, con fallback al default); con `ioServiceId` esplicito, lookup diretto SENZA fallback (se non trovato/senza chiave, lancia `BadRequestException`). Usata da Task 5 (processor).

- [ ] **Step 1: Scrivi il test che fallisce**

Aggiungi in `apps/backend/src/io-services/io-services.service.spec.ts`, dentro `describe('verifyProfile', ...)`:

```typescript
    it('con ioServiceId esplicito non trovato NON ripiega sul servizio predefinito', async () => {
      repoMock.findOneBy.mockResolvedValue(null);
      const resolveSpy = jest.spyOn(service, 'resolveApiKey');

      await expect(service.verifyProfile('RSSMRA85M01H501Z', 'id-inesistente')).rejects.toThrow(
        'Nessun servizio App IO configurato o abilitato come predefinito',
      );
      expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('con ioServiceId esplicito esistente usa la chiave di quel servizio', async () => {
      const created = await service.create({
        nome: 'TARI', idService: 'SVC-BULK', apiKeyPrimaria: 'chiave-bulk',
      } as any);
      repoMock.findOneBy.mockResolvedValue({
        id: created.id,
        idService: 'SVC-BULK',
        apiKeyPrimariaEnc: repoMock.create.mock.calls[repoMock.create.mock.calls.length - 1][0].apiKeyPrimariaEnc,
      });
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ sender_allowed: true }) });
      global.fetch = fetchMock;

      const result = await service.verifyProfile('RSSMRA85M01H501Z', created.id);

      expect(result.active).toBe(true);
      expect(repoMock.findOneBy).toHaveBeenCalledWith({ id: created.id });
    });
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest io-services.service --maxWorkers=2`
Expected: FAIL — con id esplicito il metodo attuale chiama comunque `resolveApiKey()` (fallback al default), il primo test fallisce perché `resolveSpy` viene chiamato.

- [ ] **Step 3: Implementa**

Sostituisci in `apps/backend/src/io-services/io-services.service.ts:100-106` (firma e risoluzione chiave):

```typescript
  async verifyProfile(codiceFiscale: string, ioServiceId?: string): Promise<{ success: boolean; active: boolean; message: string }> {
    if (!codiceFiscale) throw new BadRequestException('Codice fiscale richiesto');

    // Con ioServiceId esplicito (verifica bulk: la scelta del servizio è
    // deliberata, sender_allowed è per-servizio) NIENTE fallback al default —
    // un id non trovato deve fallire esplicitamente, non invalidare
    // silenziosamente il risultato verificando con un servizio diverso.
    let resolved: { apiKey: string; idService: string } | null;
    if (ioServiceId) {
      const entity = await this.repo.findOneBy({ id: ioServiceId });
      resolved = entity && entity.apiKeyPrimariaEnc
        ? { apiKey: decryptValue(entity.apiKeyPrimariaEnc, this.cryptoKey), idService: entity.idService }
        : null;
    } else {
      resolved = await this.resolveApiKey();
    }
    if (!resolved) {
      throw new BadRequestException('Nessun servizio App IO configurato o abilitato come predefinito');
    }
```

(Il resto del metodo, dalla riga `const { APP_IO_BASE_URL } = ...` in poi, resta identico — usa già `resolved.apiKey`.)

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest io-services.service --maxWorkers=2`
Expected: PASS (tutti i test, inclusi i 2 nuovi)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/io-services/io-services.service.ts apps/backend/src/io-services/io-services.service.spec.ts
git commit -m "feat(backend): verifyProfile con servizio App IO esplicito senza fallback al default"
```

---

### Task 4: `AppIoVerifyBulkService` (creazione job, stato, risultati)

**Files:**
- Create: `apps/backend/src/io-services/app-io-verify-bulk-job.types.ts`
- Create: `apps/backend/src/io-services/app-io-verify-bulk.service.ts`
- Test: `apps/backend/src/io-services/app-io-verify-bulk.service.spec.ts`

**Interfaces:**
- Consumes: `parseCsvContent` (Task 1), `AppIoVerificationJob`/`AppIoVerificationJobStatus` (Task 2), `IoServiceConfig` entity.
- Produces: `AppIoVerifyBulkService.createJob({ csvContent, hasHeaders, cfColumn, ioServiceId }): Promise<{ jobId?: string; blocked?: boolean; message?: string }>`, `getStatus(jobId): Promise<{ status, totalRows, processedRows, presentCount, absentCount, errorMessage }>`, `getResultCsv(jobId, variant: 'present' | 'absent'): Promise<string>`. Usati da Task 6 (controller). Costante `APP_IO_VERIFY_BULK_QUEUE` e tipo `AppIoVerifyBulkJobData` usati anche da Task 5 (processor) e Task 6 (module).

- [ ] **Step 1: Scrivi il test che fallisce**

```typescript
// apps/backend/src/io-services/app-io-verify-bulk.service.spec.ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { NotFoundException } from '@nestjs/common';
import { AppIoVerifyBulkService } from './app-io-verify-bulk.service';
import { AppIoVerificationJob, AppIoVerificationJobStatus } from '../entities/app-io-verification-job.entity';
import { IoServiceConfig } from '../entities/io-service-config.entity';
import { APP_IO_VERIFY_BULK_QUEUE } from './app-io-verify-bulk-job.types';

describe('AppIoVerifyBulkService', () => {
  let service: AppIoVerifyBulkService;
  const jobRepoMock = {
    create: jest.fn((x) => x),
    save: jest.fn(async (x) => ({ id: 'job-1', ...x })),
    findOneBy: jest.fn(),
  };
  const ioServiceRepoMock = { findOneBy: jest.fn() };
  const queueMock = { add: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppIoVerifyBulkService,
        { provide: getRepositoryToken(AppIoVerificationJob), useValue: jobRepoMock },
        { provide: getRepositoryToken(IoServiceConfig), useValue: ioServiceRepoMock },
        { provide: getQueueToken(APP_IO_VERIFY_BULK_QUEUE), useValue: queueMock },
      ],
    }).compile();
    service = moduleRef.get(AppIoVerifyBulkService);
  });

  describe('createJob', () => {
    it('blocked se il servizio App IO non esiste', async () => {
      ioServiceRepoMock.findOneBy.mockResolvedValue(null);
      const result = await service.createJob({ csvContent: 'cf\nRSSMRA85M01H501Z', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'nope' });
      expect(result).toEqual({ blocked: true, message: 'Servizio App IO selezionato non trovato' });
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('blocked se il CSV non ha righe di dati', async () => {
      ioServiceRepoMock.findOneBy.mockResolvedValue({ id: 'svc-1' });
      const result = await service.createJob({ csvContent: 'cf\n', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1' });
      expect(result.blocked).toBe(true);
      expect(result.message).toContain('non contiene righe');
    });

    it('blocked se la colonna CF scelta non esiste tra le intestazioni', async () => {
      ioServiceRepoMock.findOneBy.mockResolvedValue({ id: 'svc-1' });
      const result = await service.createJob({ csvContent: 'cf\nRSSMRA85M01H501Z', hasHeaders: true, cfColumn: 'colonna_sbagliata', ioServiceId: 'svc-1' });
      expect(result.blocked).toBe(true);
      expect(result.message).toContain('colonna_sbagliata');
    });

    it('crea il job e lo accoda con jobId=id del job creato', async () => {
      ioServiceRepoMock.findOneBy.mockResolvedValue({ id: 'svc-1' });
      const result = await service.createJob({ csvContent: 'cf\nRSSMRA85M01H501Z\nVRDLGI80A01H501W', hasHeaders: true, cfColumn: 'cf', ioServiceId: 'svc-1' });
      expect(result).toEqual({ jobId: 'job-1' });
      expect(jobRepoMock.create).toHaveBeenCalledWith(expect.objectContaining({
        status: AppIoVerificationJobStatus.QUEUED,
        totalRows: 2,
        ioServiceId: 'svc-1',
        cfColumn: 'cf',
      }));
      expect(queueMock.add).toHaveBeenCalledWith('verify', { jobId: 'job-1' }, { jobId: 'job-1' });
    });
  });

  describe('getStatus', () => {
    it('lancia NotFoundException se il job non esiste', async () => {
      jobRepoMock.findOneBy.mockResolvedValue(null);
      await expect(service.getStatus('missing')).rejects.toThrow(NotFoundException);
    });

    it('ritorna i campi di stato del job', async () => {
      jobRepoMock.findOneBy.mockResolvedValue({
        status: AppIoVerificationJobStatus.PROCESSING, totalRows: 10, processedRows: 5, presentCount: 0, absentCount: 0, errorMessage: null,
      });
      const result = await service.getStatus('job-1');
      expect(result).toEqual({ status: AppIoVerificationJobStatus.PROCESSING, totalRows: 10, processedRows: 5, presentCount: 0, absentCount: 0, errorMessage: null });
    });
  });

  describe('getResultCsv', () => {
    it('lancia se il job non è DONE', async () => {
      jobRepoMock.findOneBy.mockResolvedValue({ status: AppIoVerificationJobStatus.PROCESSING });
      await expect(service.getResultCsv('job-1', 'present')).rejects.toThrow('non è ancora completato');
    });

    it('ritorna il CSV richiesto quando DONE', async () => {
      jobRepoMock.findOneBy.mockResolvedValue({
        status: AppIoVerificationJobStatus.DONE, resultPresentCsv: 'PRESENTI', resultAbsentCsv: 'ASSENTI',
      });
      expect(await service.getResultCsv('job-1', 'present')).toBe('PRESENTI');
      expect(await service.getResultCsv('job-1', 'absent')).toBe('ASSENTI');
    });
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest app-io-verify-bulk.service --maxWorkers=2`
Expected: FAIL — `Cannot find module './app-io-verify-bulk.service'`

- [ ] **Step 3: Implementa**

```typescript
// apps/backend/src/io-services/app-io-verify-bulk-job.types.ts
export const APP_IO_VERIFY_BULK_QUEUE = 'app-io-verify-bulk';

export interface AppIoVerifyBulkJobData {
  jobId: string;
}
```

```typescript
// apps/backend/src/io-services/app-io-verify-bulk.service.ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { AppIoVerificationJob, AppIoVerificationJobStatus } from '../entities/app-io-verification-job.entity';
import { IoServiceConfig } from '../entities/io-service-config.entity';
import { parseCsvContent } from './csv.util';
import { APP_IO_VERIFY_BULK_QUEUE, AppIoVerifyBulkJobData } from './app-io-verify-bulk-job.types';

export interface CreateBulkVerifyParams {
  csvContent: string;
  hasHeaders: boolean;
  cfColumn: string;
  ioServiceId: string;
}

export interface CreateBulkVerifyResult {
  jobId?: string;
  blocked?: boolean;
  message?: string;
}

export interface BulkVerifyStatus {
  status: AppIoVerificationJobStatus;
  totalRows: number;
  processedRows: number;
  presentCount: number;
  absentCount: number;
  errorMessage: string | null;
}

@Injectable()
export class AppIoVerifyBulkService {
  constructor(
    @InjectRepository(AppIoVerificationJob)
    private readonly jobRepo: Repository<AppIoVerificationJob>,
    @InjectRepository(IoServiceConfig)
    private readonly ioServiceRepo: Repository<IoServiceConfig>,
    @InjectQueue(APP_IO_VERIFY_BULK_QUEUE)
    private readonly queue: Queue<AppIoVerifyBulkJobData>,
  ) {}

  async createJob(params: CreateBulkVerifyParams): Promise<CreateBulkVerifyResult> {
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

    const job = this.jobRepo.create({
      status: AppIoVerificationJobStatus.QUEUED,
      totalRows: parsed.rows.length,
      processedRows: 0,
      presentCount: 0,
      absentCount: 0,
      sourceCsv: params.csvContent,
      csvHeaders: parsed.headers,
      cfColumn: params.cfColumn,
      hasHeaders: params.hasHeaders,
      ioServiceId: params.ioServiceId,
      resultPresentCsv: null,
      resultAbsentCsv: null,
      errorMessage: null,
      completedAt: null,
    });
    const saved = await this.jobRepo.save(job);

    await this.queue.add('verify', { jobId: saved.id }, { jobId: saved.id });

    return { jobId: saved.id };
  }

  async getStatus(jobId: string): Promise<BulkVerifyStatus> {
    const job = await this.jobRepo.findOneBy({ id: jobId });
    if (!job) throw new NotFoundException(`Job di verifica ${jobId} non trovato`);
    return {
      status: job.status,
      totalRows: job.totalRows,
      processedRows: job.processedRows,
      presentCount: job.presentCount,
      absentCount: job.absentCount,
      errorMessage: job.errorMessage,
    };
  }

  async getResultCsv(jobId: string, variant: 'present' | 'absent'): Promise<string> {
    const job = await this.jobRepo.findOneBy({ id: jobId });
    if (!job) throw new NotFoundException(`Job di verifica ${jobId} non trovato`);
    if (job.status !== AppIoVerificationJobStatus.DONE) {
      throw new BadRequestException('Il job di verifica non è ancora completato');
    }
    const content = variant === 'present' ? job.resultPresentCsv : job.resultAbsentCsv;
    if (!content) throw new NotFoundException('Risultato non disponibile');
    return content;
  }
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest app-io-verify-bulk.service --maxWorkers=2`
Expected: PASS (8 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/io-services/app-io-verify-bulk-job.types.ts apps/backend/src/io-services/app-io-verify-bulk.service.ts apps/backend/src/io-services/app-io-verify-bulk.service.spec.ts
git commit -m "feat(backend): AppIoVerifyBulkService, creazione job e lettura stato/risultati"
```

---

### Task 5: `AppIoVerifyBulkProcessor` (worker BullMQ)

**Files:**
- Create: `apps/backend/src/io-services/app-io-verify-bulk.processor.ts`
- Test: `apps/backend/src/io-services/app-io-verify-bulk.processor.spec.ts`

**Interfaces:**
- Consumes: `AppIoVerificationJob`/`AppIoVerificationJobStatus` (Task 2), `parseCsvContent`/`buildCsvContent` (Task 1), `IoServicesService.verifyProfile(cf, ioServiceId)` (Task 3), `APP_IO_VERIFY_BULK_QUEUE`/`AppIoVerifyBulkJobData` (Task 4).
- Produces: `isPresentResult(result: { success: boolean; active: boolean; message: string }): boolean` (funzione pura esportata, usata anche dal test), classe `AppIoVerifyBulkProcessor extends WorkerHost` con `process(job: Job<AppIoVerifyBulkJobData>): Promise<void>`. Registrata come provider in Task 6.

- [ ] **Step 1: Scrivi il test che fallisce**

```typescript
// apps/backend/src/io-services/app-io-verify-bulk.processor.spec.ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppIoVerifyBulkProcessor, isPresentResult } from './app-io-verify-bulk.processor';
import { AppIoVerificationJob, AppIoVerificationJobStatus } from '../entities/app-io-verification-job.entity';
import { IoServicesService } from './io-services.service';

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
  const ioServicesMock = { verifyProfile: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppIoVerifyBulkProcessor,
        { provide: getRepositoryToken(AppIoVerificationJob), useValue: jobRepoMock },
        { provide: IoServicesService, useValue: ioServicesMock },
      ],
    }).compile();
    processor = moduleRef.get(AppIoVerifyBulkProcessor);
  });

  it('classifica presenti/assenti, scrive i CSV risultato e marca DONE', async () => {
    jobRepoMock.findOneBy.mockResolvedValue({
      id: 'job-1',
      sourceCsv: 'cf,nome\nRSSMRA85M01H501Z,Mario Rossi\nAAAAAA,CF Corto\nVRDLGI80A01H501W,Luigi Verdi',
      hasHeaders: true,
      cfColumn: 'cf',
      ioServiceId: 'svc-1',
    });
    ioServicesMock.verifyProfile.mockImplementation(async (cf: string) => {
      if (cf === 'RSSMRA85M01H501Z') return { success: true, active: true, message: 'Iscritto ad App IO e messaggi abilitati' };
      return { success: true, active: false, message: 'Cittadino non iscritto ad App IO' };
    });

    await processor.process({ data: { jobId: 'job-1' } } as any);

    expect(ioServicesMock.verifyProfile).toHaveBeenCalledTimes(2); // AAAAAA è CF non plausibile, nessuna chiamata
    expect(ioServicesMock.verifyProfile).toHaveBeenCalledWith('RSSMRA85M01H501Z', 'svc-1');
    expect(ioServicesMock.verifyProfile).toHaveBeenCalledWith('VRDLGI80A01H501W', 'svc-1');

    const doneCall = jobRepoMock.update.mock.calls.find(([, patch]) => patch.status === AppIoVerificationJobStatus.DONE);
    expect(doneCall).toBeDefined();
    const [, patch] = doneCall;
    expect(patch.presentCount).toBe(1);
    expect(patch.absentCount).toBe(2);
    expect(patch.resultPresentCsv).toContain('RSSMRA85M01H501Z');
    expect(patch.resultAbsentCsv).toContain('AAAAAA');
    expect(patch.resultAbsentCsv).toContain('VRDLGI80A01H501W');
  });

  it('marca FAILED se verifyProfile lancia un errore non gestito (es. servizio cancellato a metà job)', async () => {
    jobRepoMock.findOneBy.mockResolvedValue({
      id: 'job-2',
      sourceCsv: 'cf\nRSSMRA85M01H501Z',
      hasHeaders: true,
      cfColumn: 'cf',
      ioServiceId: 'svc-deleted',
    });
    ioServicesMock.verifyProfile.mockRejectedValue(new Error('boom'));

    await processor.process({ data: { jobId: 'job-2' } } as any);

    // Un errore per-riga viene assorbito come "assente" (stesso trattamento
    // degli errori di rete già gestiti dentro verifyProfile), il job non va
    // in FAILED per un singolo fallimento di riga.
    const doneCall = jobRepoMock.update.mock.calls.find(([, patch]) => patch.status === AppIoVerificationJobStatus.DONE);
    expect(doneCall).toBeDefined();
    expect(doneCall[1].absentCount).toBe(1);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest app-io-verify-bulk.processor --maxWorkers=2`
Expected: FAIL — `Cannot find module './app-io-verify-bulk.processor'`

- [ ] **Step 3: Implementa**

```typescript
// apps/backend/src/io-services/app-io-verify-bulk.processor.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppIoVerificationJob, AppIoVerificationJobStatus } from '../entities/app-io-verification-job.entity';
import { IoServicesService } from './io-services.service';
import { parseCsvContent, buildCsvContent } from './csv.util';
import { APP_IO_VERIFY_BULK_QUEUE, AppIoVerifyBulkJobData } from './app-io-verify-bulk-job.types';

const PROGRESS_UPDATE_EVERY = 25;
const CONCURRENCY = 5;

/** Stessa convenzione già usata in App.tsx per la verifica singola: un
 * profilo con messaggi disabilitati per questo servizio non è "presente"
 * ai fini di un successivo invio reale. */
export function isPresentResult(result: { success: boolean; active: boolean; message: string }): boolean {
  return result.success && result.active && !result.message.includes('disabilitati');
}

@Injectable()
@Processor(APP_IO_VERIFY_BULK_QUEUE)
export class AppIoVerifyBulkProcessor extends WorkerHost {
  private readonly logger = new Logger(AppIoVerifyBulkProcessor.name);

  constructor(
    @InjectRepository(AppIoVerificationJob)
    private readonly jobRepo: Repository<AppIoVerificationJob>,
    private readonly ioServices: IoServicesService,
  ) {
    super();
  }

  async process(job: Job<AppIoVerifyBulkJobData>): Promise<void> {
    const { jobId } = job.data;
    const record = await this.jobRepo.findOneBy({ id: jobId });
    if (!record) {
      this.logger.warn(`AppIoVerificationJob ${jobId} non trovato — job BullMQ scartato`);
      return;
    }

    await this.jobRepo.update(jobId, { status: AppIoVerificationJobStatus.PROCESSING });

    try {
      const parsed = parseCsvContent(record.sourceCsv, record.hasHeaders);
      const presentRows: Record<string, string>[] = [];
      const absentRows: Record<string, string>[] = [];
      let processed = 0;

      const runRow = async (row: Record<string, string>) => {
        const cf = (row[record.cfColumn] || '').trim().toUpperCase();
        let present = false;
        if (cf.length === 16) {
          try {
            const result = await this.ioServices.verifyProfile(cf, record.ioServiceId);
            present = isPresentResult(result);
          } catch {
            // Errore non gestito da verifyProfile (es. servizio eliminato a
            // metà job): stesso trattamento degli errori di rete, la riga
            // finisce tra gli assenti, il job intero non fallisce per questo.
            present = false;
          }
        }
        (present ? presentRows : absentRows).push(row);
        processed += 1;
        if (processed % PROGRESS_UPDATE_EVERY === 0) {
          await this.jobRepo.update(jobId, { processedRows: processed });
        }
      };

      for (let i = 0; i < parsed.rows.length; i += CONCURRENCY) {
        const batch = parsed.rows.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(runRow));
      }

      await this.jobRepo.update(jobId, {
        status: AppIoVerificationJobStatus.DONE,
        processedRows: parsed.rows.length,
        presentCount: presentRows.length,
        absentCount: absentRows.length,
        resultPresentCsv: buildCsvContent(parsed.headers, presentRows),
        resultAbsentCsv: buildCsvContent(parsed.headers, absentRows),
        completedAt: new Date(),
      });
      this.logger.log(`AppIoVerificationJob ${jobId} completato: ${presentRows.length} presenti, ${absentRows.length} assenti`);
    } catch (err: any) {
      this.logger.error(`AppIoVerificationJob ${jobId} fallito: ${err.message}`);
      await this.jobRepo.update(jobId, {
        status: AppIoVerificationJobStatus.FAILED,
        errorMessage: err.message,
        completedAt: new Date(),
      });
    }
  }
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest app-io-verify-bulk.processor --maxWorkers=2`
Expected: PASS (3 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/io-services/app-io-verify-bulk.processor.ts apps/backend/src/io-services/app-io-verify-bulk.processor.spec.ts
git commit -m "feat(backend): worker BullMQ verifica App IO massiva"
```

---

### Task 6: Wiring modulo, DTO, endpoint controller

**Files:**
- Modify: `apps/backend/src/io-services/io-services.module.ts`
- Modify: `apps/backend/src/io-services/io-services.controller.ts`
- Modify: `apps/backend/src/io-services/dto/io-service.dto.ts`

**Interfaces:**
- Consumes: `AppIoVerifyBulkService` (Task 4), `AppIoVerifyBulkProcessor` (Task 5), `AppIoVerificationJob` entity (Task 2), `APP_IO_VERIFY_BULK_QUEUE` (Task 4).
- Produces endpoint REST: `POST admin/io-services/verify-bulk`, `GET admin/io-services/verify-bulk/:id`, `GET admin/io-services/verify-bulk/:id/present.csv`, `GET admin/io-services/verify-bulk/:id/absent.csv`. Consumati da Task 7 (frontend).

- [ ] **Step 1: Aggiungi il DTO**

In `apps/backend/src/io-services/dto/io-service.dto.ts`, aggiorna l'import in cima al file e aggiungi la classe in fondo:

```typescript
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
```

```typescript
export class VerifyBulkDto {
  @IsString() @MinLength(1)
  csvContent!: string;

  @IsBoolean()
  hasHeaders!: boolean;

  @IsString() @MinLength(1)
  cfColumn!: string;

  @IsUUID()
  ioServiceId!: string;
}
```

- [ ] **Step 2: Aggiorna il modulo**

Sostituisci il contenuto di `apps/backend/src/io-services/io-services.module.ts`:

```typescript
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { IoServiceConfig } from '../entities/io-service-config.entity';
import { AppIoVerificationJob } from '../entities/app-io-verification-job.entity';
import { IoServicesService } from './io-services.service';
import { IoServicesController } from './io-services.controller';
import { AppIoVerifyBulkService } from './app-io-verify-bulk.service';
import { AppIoVerifyBulkProcessor } from './app-io-verify-bulk.processor';
import { APP_IO_VERIFY_BULK_QUEUE } from './app-io-verify-bulk-job.types';

// @Global(): AppIoStrategy (in ChannelModule) inietta IoServicesService senza importare
// esplicitamente questo modulo — stesso pattern di MailConfigsModule.
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([IoServiceConfig, AppIoVerificationJob]),
    BullModule.registerQueue({ name: APP_IO_VERIFY_BULK_QUEUE }),
  ],
  controllers: [IoServicesController],
  providers: [IoServicesService, AppIoVerifyBulkService, AppIoVerifyBulkProcessor],
  exports: [IoServicesService],
})
export class IoServicesModule {}
```

- [ ] **Step 3: Aggiungi gli endpoint al controller**

Modifica `apps/backend/src/io-services/io-services.controller.ts`:

```typescript
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { IoServicesService } from './io-services.service';
import { AppIoVerifyBulkService } from './app-io-verify-bulk.service';
import { CreateIoServiceDto, UpdateIoServiceDto, TestIoServiceDto, VerifyBulkDto } from './dto/io-service.dto';

@Controller('admin/io-services')
export class IoServicesController {
  constructor(
    private readonly svc: IoServicesService,
    private readonly bulkSvc: AppIoVerifyBulkService,
  ) {}
```

(gli endpoint esistenti `list`, `create`, `update`, `remove`, `setDefault`, `test`, `verify-profile` restano invariati) e aggiungi in fondo alla classe, prima della chiusura `}`:

```typescript
  @Post('verify-bulk')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  createVerifyBulk(@Body() body: VerifyBulkDto) {
    return this.bulkSvc.createJob(body);
  }

  @Get('verify-bulk/:id')
  @Roles('user', 'admin')
  getVerifyBulkStatus(@Param('id', ParseUUIDPipe) id: string) {
    return this.bulkSvc.getStatus(id);
  }

  @Get('verify-bulk/:id/present.csv')
  @Roles('user', 'admin')
  async downloadVerifyBulkPresent(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const content = await this.bulkSvc.getResultCsv(id, 'present');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="verifica_appio_presenti_${id.slice(0, 8)}.csv"`);
    res.send(content);
  }

  @Get('verify-bulk/:id/absent.csv')
  @Roles('user', 'admin')
  async downloadVerifyBulkAbsent(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const content = await this.bulkSvc.getResultCsv(id, 'absent');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="verifica_appio_assenti_${id.slice(0, 8)}.csv"`);
    res.send(content);
  }
```

- [ ] **Step 4: Verifica compilazione e suite completa**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso set di fallimenti pre-esistente (solo `app.controller.spec.ts`/`isLdapMock`, vedi CLAUDE.md), nessuna nuova regressione.

Run: `docker compose restart backend` (il watch NestJS spesso non vede modifiche su bind mount Windows), poi verifica manualmente con un token operatore di debug:
```bash
docker compose exec backend node -e "const jwt=require('/app/node_modules/.pnpm/node_modules/jsonwebtoken');console.log(jwt.sign({sub:'debug',username:'debug',role:'admin',type:'operator'},process.env.JWT_SECRET,{expiresIn:'10m'}))"
```
poi una `POST http://localhost:8080/admin/io-services/verify-bulk` con un servizio App IO reale configurato in dev, per confermare che il job venga creato ed eseguito end-to-end (log backend `LOG_LEVEL=debug` mostra le chiamate PagoPA).

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/io-services/io-services.module.ts apps/backend/src/io-services/io-services.controller.ts apps/backend/src/io-services/dto/io-service.dto.ts
git commit -m "feat(backend): endpoint REST verifica App IO massiva"
```

---

### Task 7: Frontend — tab "Massiva CSV" nella pagina Verifica App IO

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (stato nuovo vicino a `verificaCf`/`verificaResult` — righe 504-506; blocco JSX della vista `verifica-appio` — righe 6261-6336)

**Interfaces:**
- Consumes: endpoint backend di Task 6 (`POST /io-services/verify-bulk`, `GET /io-services/verify-bulk/:id`, `GET /io-services/verify-bulk/:id/present.csv`, `GET /io-services/verify-bulk/:id/absent.csv`), `apiFetch` esistente, stato `ioServices: IoService[]` esistente (già caricato in App.tsx).

- [ ] **Step 1: Aggiungi lo stato dedicato**

Dopo la riga `const [verificaResult, setVerificaResult] = useState<...>(null);` (riga 506), aggiungi:

```typescript
  const [verificaTab, setVerificaTab] = useState<'singola' | 'massiva'>('singola');
  const [verificaBulkFile, setVerificaBulkFile] = useState<File | null>(null);
  const [verificaBulkHasHeaders, setVerificaBulkHasHeaders] = useState(true);
  const [verificaBulkHeaders, setVerificaBulkHeaders] = useState<string[]>([]);
  const [verificaBulkCfColumn, setVerificaBulkCfColumn] = useState('');
  const [verificaBulkServiceId, setVerificaBulkServiceId] = useState('');
  const [verificaBulkJobId, setVerificaBulkJobId] = useState<string | null>(null);
  const [verificaBulkStatus, setVerificaBulkStatus] = useState<{
    status: 'queued' | 'processing' | 'done' | 'failed';
    totalRows: number;
    processedRows: number;
    presentCount: number;
    absentCount: number;
    errorMessage: string | null;
  } | null>(null);
  const [verificaBulkSubmitting, setVerificaBulkSubmitting] = useState(false);
  const [verificaBulkSubmitError, setVerificaBulkSubmitError] = useState<string | null>(null);
```

- [ ] **Step 2: Aggiungi handler e polling**

Subito dopo la funzione `runVerificaAppIo` esistente (dopo la riga 1270 `};`), aggiungi:

```typescript
  useEffect(() => {
    const def = ioServices.find(s => s.isDefault);
    if (def) setVerificaBulkServiceId(def.id);
    else if (ioServices.length > 0) setVerificaBulkServiceId(ioServices[0].id);
  }, [ioServices]);

  const parseVerificaBulkHeaders = (file: File, hasHeaders: boolean) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (!text) return;
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
      if (lines.length === 0) { setVerificaBulkHeaders([]); return; }
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
      setVerificaBulkHeaders(headers);
      const guessed = headers.find(h => ['codicefiscale', 'cf'].includes(h.toLowerCase().replace(/[\s_-]/g, '')));
      setVerificaBulkCfColumn(guessed || '');
    };
    reader.readAsText(file);
  };

  const handleVerificaBulkFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setVerificaBulkFile(file);
    setVerificaBulkJobId(null);
    setVerificaBulkStatus(null);
    setVerificaBulkSubmitError(null);
    parseVerificaBulkHeaders(file, verificaBulkHasHeaders);
  };

  const handleVerificaBulkSubmit = async () => {
    if (!verificaBulkFile || !verificaBulkCfColumn || !verificaBulkServiceId) return;
    setVerificaBulkSubmitting(true);
    setVerificaBulkSubmitError(null);
    try {
      const csvContent = await verificaBulkFile.text();
      const res = await apiFetch('/io-services/verify-bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          csvContent,
          hasHeaders: verificaBulkHasHeaders,
          cfColumn: verificaBulkCfColumn,
          ioServiceId: verificaBulkServiceId,
        }),
      });
      const data = await res.json();
      if (data.blocked) {
        setVerificaBulkSubmitError(data.message || 'Richiesta bloccata');
        return;
      }
      setVerificaBulkJobId(data.jobId);
      setVerificaBulkStatus({ status: 'queued', totalRows: 0, processedRows: 0, presentCount: 0, absentCount: 0, errorMessage: null });
    } catch (err: any) {
      setVerificaBulkSubmitError(err.message || 'Errore di connessione');
    } finally {
      setVerificaBulkSubmitting(false);
    }
  };

  useEffect(() => {
    if (!verificaBulkJobId) return;
    if (verificaBulkStatus?.status === 'done' || verificaBulkStatus?.status === 'failed') return;
    const timer = setInterval(async () => {
      try {
        const res = await apiFetch(`/io-services/verify-bulk/${verificaBulkJobId}`);
        const data = await res.json();
        setVerificaBulkStatus(data);
      } catch {
        // errore transitorio di polling: riprova al giro successivo
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [verificaBulkJobId, verificaBulkStatus?.status]);

  const handleVerificaBulkDownload = async (variant: 'present' | 'absent') => {
    if (!verificaBulkJobId) return;
    try {
      const res = await apiFetch(`/io-services/verify-bulk/${verificaBulkJobId}/${variant}.csv`);
      if (!res.ok) { alert('Errore durante il download'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `verifica_appio_${variant === 'present' ? 'presenti' : 'assenti'}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch {
      alert('Errore durante il download');
    }
  };

  const handleVerificaBulkReset = () => {
    setVerificaBulkFile(null);
    setVerificaBulkHeaders([]);
    setVerificaBulkCfColumn('');
    setVerificaBulkJobId(null);
    setVerificaBulkStatus(null);
    setVerificaBulkSubmitError(null);
  };
```

- [ ] **Step 3: Sostituisci il blocco JSX della vista con le due tab**

Sostituisci l'intero blocco `{view === 'verifica-appio' && ( ... )}` (righe 6261-6336) con:

```tsx
          {view === 'verifica-appio' && (
            <div style={{ maxWidth: '700px', margin: '0 auto' }}>
              <h3 className="h5 fw-bold text-dark mb-3">
                <i className="fas fa-user-check me-2"></i>Verifica Stato App IO
              </h3>

              <ul className="nav nav-tabs mb-4">
                <li className="nav-item">
                  <button className={`nav-link ${verificaTab === 'singola' ? 'active' : ''}`} onClick={() => setVerificaTab('singola')}>
                    Verifica singola
                  </button>
                </li>
                <li className="nav-item">
                  <button className={`nav-link ${verificaTab === 'massiva' ? 'active' : ''}`} onClick={() => setVerificaTab('massiva')}>
                    Verifica massiva CSV
                  </button>
                </li>
              </ul>

              {verificaTab === 'singola' && (
                <>
                  <p className="small text-muted mb-4">
                    Inserisci il codice fiscale di un cittadino per verificare in tempo reale se ha installato App IO, se è attivo sul canale ed eventualmente se ha abilitato i messaggi inviati dall'Ente. Utile ad esempio per la ricerca degli irreperibili.
                  </p>

                  <div className="card shadow-sm p-4 mb-4">
                    <div className="mb-3">
                      <label className="form-label small fw-bold">Codice Fiscale</label>
                      <div className="input-group input-group-sm">
                        <span className="input-group-text"><i className="fas fa-id-card"></i></span>
                        <input
                          type="text"
                          className="form-control"
                          placeholder="Inserisci il codice fiscale (16 caratteri)"
                          maxLength={16}
                          value={verificaCf}
                          onChange={e => setVerificaCf(e.target.value.toUpperCase().trim())}
                          onKeyDown={e => { if (e.key === 'Enter') runVerificaAppIo(); }}
                        />
                        <button
                          className="btn btn-primary"
                          type="button"
                          onClick={runVerificaAppIo}
                          disabled={verificaLoading || !verificaCf.trim()}
                        >
                          {verificaLoading ? (
                            <>
                              <i className="fas fa-spinner fa-spin me-1"></i>Verifica...
                            </>
                          ) : (
                            <>
                              <i className="fas fa-search me-1"></i>Verifica
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    {verificaResult && (
                      <div className={`mt-3 p-3 border rounded ${
                        !verificaResult.success ? 'border-danger bg-light' :
                        !verificaResult.active ? 'border-secondary bg-light' :
                        verificaResult.message.includes('disabilitati') ? 'border-warning bg-light' :
                        'border-success bg-light'
                      }`}>
                        <div className="d-flex align-items-start gap-3">
                          <div style={{ fontSize: '1.8rem' }}>
                            {!verificaResult.success ? (
                              <i className="fas fa-circle-exclamation text-danger"></i>
                            ) : !verificaResult.active ? (
                              <i className="fas fa-circle-xmark text-secondary"></i>
                            ) : verificaResult.message.includes('disabilitati') ? (
                              <i className="fas fa-circle-exclamation text-warning"></i>
                            ) : (
                              <i className="fas fa-circle-check text-success"></i>
                            )}
                          </div>
                          <div>
                            <h6 className="fw-bold mb-1">
                              {!verificaResult.success ? 'Errore di sistema' :
                               !verificaResult.active ? 'Cittadino non attivo' :
                               verificaResult.message.includes('disabilitati') ? 'Attivo con restrizioni' :
                               'Cittadino attivo su App IO'}
                            </h6>
                            <p className="small text-muted mb-0">{verificaResult.message}</p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}

              {verificaTab === 'massiva' && (
                <div className="card shadow-sm p-4 mb-4">
                  <p className="small text-muted mb-3">
                    Carica un CSV con un elenco di codici fiscali: la verifica gira in background (può richiedere alcuni minuti su elenchi ampi) e produce due CSV scaricabili, con le stesse colonne del file originale — destinatari raggiungibili su App IO e tutti gli altri.
                  </p>

                  {!verificaBulkJobId && (
                    <>
                      <div className="mb-3">
                        <label className="form-label small fw-bold">Servizio App IO da usare per la verifica</label>
                        <select className="form-select form-select-sm" value={verificaBulkServiceId} onChange={e => setVerificaBulkServiceId(e.target.value)}>
                          {ioServices.map(s => (
                            <option key={s.id} value={s.id}>{s.nome}{s.isDefault ? ' (predefinito)' : ''}</option>
                          ))}
                        </select>
                        <div className="form-text small text-muted">
                          I messaggi abilitati/disabilitati sono specifici per servizio: usa lo stesso servizio che userai per l'invio reale, altrimenti il risultato non è affidabile.
                        </div>
                      </div>

                      <div className="mb-3">
                        <div className="form-check form-check-inline">
                          <input className="form-check-input" type="checkbox" id="verificaBulkHasHeaders" checked={verificaBulkHasHeaders}
                            onChange={e => {
                              setVerificaBulkHasHeaders(e.target.checked);
                              if (verificaBulkFile) parseVerificaBulkHeaders(verificaBulkFile, e.target.checked);
                            }} />
                          <label className="form-check-label small" htmlFor="verificaBulkHasHeaders">Il file ha una riga di intestazione</label>
                        </div>
                      </div>

                      <div className="mb-3">
                        <label className="form-label small fw-bold">File CSV</label>
                        <input type="file" accept=".csv" className="form-control form-control-sm" onChange={handleVerificaBulkFileChange} />
                      </div>

                      {verificaBulkHeaders.length > 0 && (
                        <div className="mb-3">
                          <label className="form-label small fw-bold">Colonna Codice Fiscale</label>
                          <select className="form-select form-select-sm" value={verificaBulkCfColumn} onChange={e => setVerificaBulkCfColumn(e.target.value)}>
                            <option value="">— seleziona —</option>
                            {verificaBulkHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                        </div>
                      )}

                      {verificaBulkSubmitError && (
                        <div className="alert alert-danger small">{verificaBulkSubmitError}</div>
                      )}

                      <button
                        className="btn btn-primary btn-sm"
                        type="button"
                        onClick={handleVerificaBulkSubmit}
                        disabled={verificaBulkSubmitting || !verificaBulkFile || !verificaBulkCfColumn || !verificaBulkServiceId}
                      >
                        {verificaBulkSubmitting ? (
                          <><i className="fas fa-spinner fa-spin me-1"></i>Avvio...</>
                        ) : (
                          <><i className="fas fa-play me-1"></i>Avvia verifica</>
                        )}
                      </button>
                    </>
                  )}

                  {verificaBulkJobId && verificaBulkStatus && (
                    <div>
                      {(verificaBulkStatus.status === 'queued' || verificaBulkStatus.status === 'processing') && (
                        <>
                          <p className="small text-muted mb-2">
                            Verifica in corso: {verificaBulkStatus.processedRows} / {verificaBulkStatus.totalRows || '…'} righe processate.
                          </p>
                          <div className="progress" style={{ height: '8px' }}>
                            <div
                              className="progress-bar"
                              style={{ width: verificaBulkStatus.totalRows > 0 ? `${Math.round((verificaBulkStatus.processedRows / verificaBulkStatus.totalRows) * 100)}%` : '5%' }}
                            />
                          </div>
                        </>
                      )}

                      {verificaBulkStatus.status === 'done' && (
                        <>
                          <div className="alert alert-success small">
                            Verifica completata: <strong>{verificaBulkStatus.presentCount}</strong> presenti, <strong>{verificaBulkStatus.absentCount}</strong> assenti.
                          </div>
                          <div className="d-flex gap-2 mb-3">
                            <button className="btn btn-sm btn-outline-success" onClick={() => handleVerificaBulkDownload('present')}>
                              <i className="fas fa-file-csv me-1"></i>Scarica presenti
                            </button>
                            <button className="btn btn-sm btn-outline-secondary" onClick={() => handleVerificaBulkDownload('absent')}>
                              <i className="fas fa-file-csv me-1"></i>Scarica assenti
                            </button>
                          </div>
                        </>
                      )}

                      {verificaBulkStatus.status === 'failed' && (
                        <div className="alert alert-danger small">
                          Verifica fallita: {verificaBulkStatus.errorMessage || 'errore sconosciuto'}
                        </div>
                      )}

                      {(verificaBulkStatus.status === 'done' || verificaBulkStatus.status === 'failed') && (
                        <button className="btn btn-sm btn-outline-primary" onClick={handleVerificaBulkReset}>
                          <i className="fas fa-rotate-left me-1"></i>Nuova verifica
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
```

- [ ] **Step 4: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 5: Verifica manuale nel browser**

Login admin, vai su "Verifica App IO" → tab "Verifica massiva CSV", carica un CSV di prova (poche righe, mix di CF validi/malformati), verifica: selezione servizio precompilata sul predefinito, dropdown colonna popolato correttamente, avvio job, progress bar che avanza, conteggi finali, download dei due CSV con contenuto coerente (stesse colonne del file caricato, split corretto).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend): verifica App IO massiva da CSV con download presenti/assenti"
```

---

## Self-review

**Copertura spec:** servizio esplicito senza fallback (Task 3), split presenti/assenti via `active && !message.includes('disabilitati')` (Task 5), stesse colonne output (Task 1 `buildCsvContent` + Task 5 usa `parsed.headers`), job asincrono con polling invece di richiesta sincrona (Task 2/4/5/6/7), pattern `blocked` per errori previsti (Task 4 `createJob`), CF malformato → assente diretto senza chiamata API (Task 5), job FAILED con messaggio su errore di sistema (Task 5 `catch` esterno), download solo se DONE (Task 4 `getResultCsv`) — tutti i punti della spec coperti.

**Coerenza tipi:** `AppIoVerificationJobStatus` (Task 2) usato identico in Task 4/5/6; `AppIoVerifyBulkJobData` (Task 4) usato identico in Task 5; firma `verifyProfile(cf, ioServiceId?)` (Task 3) coerente con la chiamata in Task 5; risposta `getStatus`/`getResultCsv` (Task 4) coerente con quanto atteso dal controller (Task 6) e dal polling frontend (Task 7).
