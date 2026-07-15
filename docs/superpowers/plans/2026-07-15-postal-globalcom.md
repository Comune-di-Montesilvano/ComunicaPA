# Postalizzazione reale via GlobalCom SOAP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sostituire la timbratura PDF ad-hoc del canale POSTAL con un invio
postale reale (lettera/raccomandata) tramite il web service SOAP GlobalCom,
mantenendo POSTAL su BullMQ (coda/processor/UI Motori esistenti) e
aggiungendo un demone di poll-stato consegna.

**Architecture:** `PostalStrategy.send()` (invocata dal `NotificationProcessor`
BullMQ esistente, invariato salvo 2 righe) chiama un nuovo `GlobalComClient`
(wrapper SOAP: login a sessione + invio + ricerca dedup + poll stato). Un
nuovo demone `@Cron` (`PostalStatusSyncService`) aggiorna lo stato di
consegna in background, riusando lo stesso client. Riuso diretto di
`resolvePhysicalAddress`/`getColumnValue` (già scritti per SEND) per
l'indirizzo destinatario e il riferimento gestionale tributi.

**Tech Stack:** NestJS 10, TypeORM 0.3.30, BullMQ, libreria npm `soap`
(nuova dipendenza), Jest.

## Global Constraints

- Ogni comando di test/tsc/jest va lanciato con `docker compose exec backend
  ...` (mai in locale — Node/pnpm non installati sull'host), sempre con
  `--maxWorkers=2` per jest.
- Nuove dipendenze npm: dopo modifica `package.json`, rigenerare
  `pnpm-lock.yaml` con il container node "usa e getta" documentato in
  CLAUDE.md, poi `docker compose build backend` + rimozione volume
  `comunicapa_backend_node_modules` (verificare nome esatto con `docker
  volume ls` prima di rimuoverlo).
- Migration scritte a mano seguendo lo stile esistente in
  `apps/backend/src/database/migrations/` (non generate automaticamente per
  semplici `ADD COLUMN` — nessun problema di enum qui, ma si segue comunque
  la convenzione dei file esistenti), poi registrate nell'array `migrations`
  di `database.module.ts`.
- Nessuna colonna nuova su `Recipient` — l'indirizzo e il riferimento
  gestionale tributi passano da `channelConfig`/`extraData` via
  `getColumnValue`/`resolvePhysicalAddress` (già esistenti).
- Placeholder distinguibile per dati non ancora disponibili in test:
  `Buffer.from('%PDF-1.4 test')`, stesso pattern già usato in
  `send-dispatch.service.spec.ts`.

---

## File Structure

**Nuovi file:**
- `apps/backend/src/channels/postal/globalcom-client.service.ts` — wrapper
  SOAP (login/sessione/invio/ricerca/poll-stato), unico punto che parla con
  GlobalCom.
- `apps/backend/src/channels/postal/globalcom-client.service.spec.ts`
- `apps/backend/src/channels/postal/postal-status-sync.service.ts` — demone
  `@Cron` di poll consegna.
- `apps/backend/src/channels/postal/postal-status-sync.service.spec.ts`
- `apps/backend/src/database/migrations/1784200000000-AddPostalStatusColumns.ts`

**File modificati:**
- `apps/backend/package.json` — dipendenza `soap`.
- `apps/backend/src/entities/notification-attempt.entity.ts` — 3 colonne
  nuove.
- `apps/backend/src/settings/settings.registry.ts` — chiavi `postal.*`.
- `apps/backend/src/channels/postal/postal.strategy.ts` — riscritta.
- `apps/backend/src/channels/postal/postal.strategy.spec.ts` — riscritta.
- `apps/backend/src/channels/channel.interface.ts` — `send()` con
  `attemptsMade?: number`.
- `apps/backend/src/queue/notification.processor.ts` — `isMailChannel` +
  passaggio `attemptsMade`.
- `apps/backend/src/channels/channel.module.ts` — registra
  `GlobalComClient`/`PostalStatusSyncService`.
- `apps/backend/src/database/database.module.ts` — registra la migration.
- `apps/frontend-admin/src/App.tsx` — tab Impostazioni Postal, campi wizard
  POSTAL, badge stato.

---

## Task 1: Dipendenza `soap` + colonne DB

**Files:**
- Modify: `apps/backend/package.json`
- Create: `apps/backend/src/database/migrations/1784200000000-AddPostalStatusColumns.ts`
- Modify: `apps/backend/src/database/database.module.ts`
- Modify: `apps/backend/src/entities/notification-attempt.entity.ts`

**Interfaces:**
- Produces: `NotificationAttempt.postalTrackingId: string | null`,
  `.postalStatus: string | null`, `.postalStatusUpdatedAt: Date | null` —
  usati da Task 5 (`PostalStrategy`) e Task 7 (`PostalStatusSyncService`).

- [ ] **Step 1: Aggiungi la dipendenza al `package.json` del backend**

In `apps/backend/package.json`, nella sezione `dependencies`, aggiungi:

```json
"soap": "^1.1.2",
```

- [ ] **Step 2: Rigenera `pnpm-lock.yaml` (fuori Docker, container usa e getta)**

```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "${PWD}:/w" -w /w node:22-alpine sh -c "corepack enable && corepack prepare pnpm@latest --activate && pnpm install --lockfile-only --ignore-scripts"
```

- [ ] **Step 3: Rebuild immagine backend e rimuovi il volume node_modules stantio**

```bash
docker compose build backend
docker volume ls | grep node_modules
docker compose rm -sf backend && docker volume rm comunicapa_backend_node_modules && docker compose up -d backend
```

Verifica: `docker compose exec backend node -e "require('soap'); console.log('ok')"` stampa `ok`.

- [ ] **Step 4: Aggiungi le 3 colonne all'entity `NotificationAttempt`**

In `apps/backend/src/entities/notification-attempt.entity.ts`, dopo il blocco
`uploadedDocuments` (dopo la riga `uploadedDocuments!: ...`) aggiungi:

```ts
  // Tracking consegna GlobalCom (canale POSTAL) — analogo a iun/sendStatus
  // per SEND, ma qui esiste un'operazione di poll dedicata (dettagli_documento)
  // verificata sul manuale tecnico ufficiale, vedi PostalStatusSyncService.
  @Column({ name: 'postal_tracking_id', type: 'varchar', length: 50, nullable: true })
  postalTrackingId!: string | null;

  @Column({ name: 'postal_status', type: 'varchar', length: 30, nullable: true })
  postalStatus!: string | null;

  @Column({ name: 'postal_status_updated_at', type: 'timestamptz', nullable: true })
  postalStatusUpdatedAt!: Date | null;
```

- [ ] **Step 5: Scrivi la migration**

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPostalStatusColumns1784200000000 implements MigrationInterface {
    name = 'AddPostalStatusColumns1784200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "postal_tracking_id" character varying(50)`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "postal_status" character varying(30)`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "postal_status_updated_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "postal_status_updated_at"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "postal_status"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "postal_tracking_id"`);
    }
}
```

Salva in `apps/backend/src/database/migrations/1784200000000-AddPostalStatusColumns.ts`.

- [ ] **Step 6: Registra la migration in `database.module.ts`**

Aggiungi l'import (dopo `AddUploadedDocumentsColumn1784100000000`):

```ts
import { AddPostalStatusColumns1784200000000 } from './migrations/1784200000000-AddPostalStatusColumns';
```

E nell'array `migrations: [...]`, aggiungi `AddPostalStatusColumns1784200000000`
in coda alla lista esistente.

- [ ] **Step 7: Verifica la migration su un DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_test_postal;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_test_postal" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_test_postal;"
```

Expected: nessun errore, output elenca `AddPostalStatusColumns1784200000000 ... [OK]`.

- [ ] **Step 8: Type-check e commit**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

```bash
git add apps/backend/package.json apps/backend/pnpm-lock.yaml apps/backend/src/entities/notification-attempt.entity.ts apps/backend/src/database/migrations/1784200000000-AddPostalStatusColumns.ts apps/backend/src/database/database.module.ts
git commit -m "feat(backend): aggiungi dipendenza soap e colonne tracking POSTAL/GlobalCom"
```

---

## Task 2: Settings registry — chiavi `postal.*`

**Files:**
- Modify: `apps/backend/src/settings/settings.registry.ts`
- Test: `apps/backend/src/settings/settings.registry.spec.ts` (se non esiste, verifica con `docker compose exec backend node_modules/.bin/jest settings.registry --maxWorkers=2` se c'è già copertura generica sulle chiavi; altrimenti questo task non introduce un file di test dedicato — la copertura arriva indirettamente da Task 5/7 che usano `settings.get()` con queste chiavi)

**Interfaces:**
- Produces: chiavi `SettingKey` — `'postal.baseUrl'`, `'postal.user'`,
  `'postal.password'`, `'postal.group'`, `'postal.centroDiCosto'`,
  `'postal.mittente.denominazione1'`, `'postal.mittente.indirizzo1'`,
  `'postal.mittente.cap'`, `'postal.mittente.citta'`,
  `'postal.mittente.provincia'` — consumate da `GlobalComClient`/
  `PostalStrategy` (Task 4-5) e `PostalStatusSyncService` (Task 7) via
  `AppSettingsService.get<string>(key)`.

- [ ] **Step 1: Aggiungi le chiavi al registry**

In `apps/backend/src/settings/settings.registry.ts`, dopo il blocco
`'protocollo.*'` (prima di `'system.publicUrl'`), aggiungi:

```ts
  // GlobalCom (corrispondenzadigitale.it) — postalizzazione reale canale
  // POSTAL. baseUrl è specifico per installazione (sottodominio comunale),
  // nessun default valido generico.
  'postal.baseUrl': { type: 'string', default: '' },
  'postal.user': { type: 'string', default: '' },
  'postal.password': { type: 'string', secret: true, default: '' },
  'postal.group': { type: 'string', default: '' },
  'postal.centroDiCosto': { type: 'string', default: '' },
  // Mittente esplicito facoltativo: se denominazione1 è vuoto, si usa il
  // mittente predefinito dell'utenza GlobalCom (UsaMittentePredefinito=true).
  'postal.mittente.denominazione1': { type: 'string', default: '' },
  'postal.mittente.indirizzo1': { type: 'string', default: '' },
  'postal.mittente.cap': { type: 'string', default: '' },
  'postal.mittente.citta': { type: 'string', default: '' },
  'postal.mittente.provincia': { type: 'string', default: '' },
```

- [ ] **Step 2: Type-check**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Expected: nessun errore (le chiavi sono nuove entry di un `const satisfies
Record<string, SettingDef>`, nessun consumatore le referenzia ancora).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/settings/settings.registry.ts
git commit -m "feat(backend): aggiungi settings postal.* per integrazione GlobalCom"
```

---

## Task 3: `GlobalComClient` — wrapper SOAP

**Files:**
- Create: `apps/backend/src/channels/postal/globalcom-client.service.ts`
- Test: `apps/backend/src/channels/postal/globalcom-client.service.spec.ts`

**Interfaces:**
- Consumes: libreria `soap` (`soap.createClientAsync`).
- Produces (usati da Task 5 `PostalStrategy` e Task 7
  `PostalStatusSyncService`):
  ```ts
  export interface GbcAddress {
    denominazione1: string;
    denominazione2?: string;
    indirizzo1: string;
    indirizzo2?: string;
    cap?: string;
    citta: string;
    provincia?: string;
  }

  export interface GbcCredentials {
    baseUrl: string;
    user: string;
    password: string;
    group: string;
  }

  export interface GbcInvioParams {
    servizio: 'Lettera' | 'Raccomandata';
    ricevutaDiRitorno: boolean;
    mittente: GbcAddress | null;
    destinatario: GbcAddress;
    note: string;
    protocollo?: string;
    centroDiCosto?: string;
    userData1?: string;
    fileBuffer: Buffer;
  }

  export interface GbcDocStatus {
    idPro: string;
    stato: string;
    codiceErrore?: string;
    descrizione?: string;
  }

  class GlobalComClient {
    invioExtSingolo(creds: GbcCredentials, params: GbcInvioParams): Promise<GbcDocStatus>;
    cercaPerTesto(creds: GbcCredentials, testo: string): Promise<GbcDocStatus[]>;
    dettagliDocumento(creds: GbcCredentials, idPro: string): Promise<GbcDocStatus | null>;
  }
  ```

- [ ] **Step 1: Scrivi il test per `invioExtSingolo` (caso successo)**

```ts
// apps/backend/src/channels/postal/globalcom-client.service.spec.ts
import { GlobalComClient } from './globalcom-client.service';

const mockLoginAsync = jest.fn();
const mockInvioAsync = jest.fn();
const mockListaAsync = jest.fn();
const mockDettagliAsync = jest.fn();
const mockAddHttpHeader = jest.fn();

jest.mock('soap', () => ({
  createClientAsync: jest.fn(async () => ({
    LoginAsync: mockLoginAsync,
    invio_ext_singoloAsync: mockInvioAsync,
    lista_documentiAsync: mockListaAsync,
    dettagli_documentoAsync: mockDettagliAsync,
    addHttpHeader: mockAddHttpHeader,
    lastResponseHeaders: { 'set-cookie': ['ASP.NET_SessionId=abc123; path=/'] },
  })),
}));

describe('GlobalComClient', () => {
  let client: GlobalComClient;
  const creds = { baseUrl: 'https://esempio.corrispondenzadigitale.it/gbcweb/GBCWebservice.asmx', user: 'u', password: 'p', group: 'g' };

  beforeEach(() => {
    jest.clearAllMocks();
    client = new GlobalComClient();
    mockLoginAsync.mockResolvedValue([{ LoginResult: true, message: '' }]);
  });

  it('invioExtSingolo effettua login, apre sessione via cookie e invia il documento', async () => {
    mockInvioAsync.mockResolvedValue([{
      Result: true,
      Risposta: { IDPRO: 'IDPRO123', Stato: 'Accettato', CodiceErrore: '', Descrizione: '' },
      Messaggio: '',
    }]);

    const result = await client.invioExtSingolo(creds, {
      servizio: 'Raccomandata',
      ricevutaDiRitorno: true,
      mittente: null,
      destinatario: { denominazione1: 'Mario Rossi', indirizzo1: 'Via Roma 1', cap: '65015', citta: 'Montesilvano', provincia: 'PE' },
      note: 'attempt-uuid-123',
      fileBuffer: Buffer.from('%PDF-1.4 test'),
    });

    expect(mockLoginAsync).toHaveBeenCalledWith({ user: 'u', password: 'p', gruppo: 'g' });
    expect(mockAddHttpHeader).toHaveBeenCalledWith('Cookie', 'ASP.NET_SessionId=abc123');
    expect(mockInvioAsync).toHaveBeenCalledWith(expect.objectContaining({
      Invio: expect.objectContaining({
        Servizio: 'Raccomandata',
        RicevutaDiRitorno: true,
        UsaMittentePredefinito: true,
        Note: 'attempt-uuid-123',
        Destinatari: [expect.objectContaining({ Denominazione1: 'Mario Rossi', Citta: 'Montesilvano' })],
      }),
    }));
    expect(result).toEqual({ idPro: 'IDPRO123', stato: 'Accettato', codiceErrore: '', descrizione: '' });
  });

  it('invioExtSingolo lancia se Login fallisce', async () => {
    mockLoginAsync.mockResolvedValue([{ LoginResult: false, message: 'credenziali errate' }]);

    await expect(client.invioExtSingolo(creds, {
      servizio: 'Lettera',
      ricevutaDiRitorno: false,
      mittente: null,
      destinatario: { denominazione1: 'X', indirizzo1: 'Y', citta: 'Z' },
      note: 'n',
      fileBuffer: Buffer.from('x'),
    })).rejects.toThrow('Login GlobalCom fallito: credenziali errate');
  });

  it('invioExtSingolo lancia se il risultato non è Result=true', async () => {
    mockInvioAsync.mockResolvedValue([{ Result: false, Risposta: null, Messaggio: 'errore generico' }]);

    await expect(client.invioExtSingolo(creds, {
      servizio: 'Lettera',
      ricevutaDiRitorno: false,
      mittente: null,
      destinatario: { denominazione1: 'X', indirizzo1: 'Y', citta: 'Z' },
      note: 'n',
      fileBuffer: Buffer.from('x'),
    })).rejects.toThrow('invio_ext_singolo fallito: errore generico');
  });

  it('cercaPerTesto interroga lista_documenti con SoloTesto', async () => {
    mockListaAsync.mockResolvedValue([{
      Risposta: [{ IDPRO: 'IDPRO999', Stato: 'Consegnato', CodiceErrore: '', Descrizione: '' }],
      Messaggio: '',
    }]);

    const result = await client.cercaPerTesto(creds, 'attempt-uuid-123');

    expect(mockListaAsync).toHaveBeenCalledWith({
      Filtri: { Testo: 'attempt-uuid-123', SoloTesto: true, Limite: 1 },
    });
    expect(result).toEqual([{ idPro: 'IDPRO999', stato: 'Consegnato', codiceErrore: '', descrizione: '' }]);
  });

  it('dettagliDocumento ritorna null se il documento non è trovato', async () => {
    mockDettagliAsync.mockResolvedValue([{ Result: true, Risposta: null, Messaggio: '' }]);

    const result = await client.dettagliDocumento(creds, 'IDPRO000');

    expect(result).toBeNull();
  });

  it('dettagliDocumento ritorna lo stato quando il documento esiste', async () => {
    mockDettagliAsync.mockResolvedValue([{
      Result: true,
      Risposta: { IDPRO: 'IDPRO000', Stato: 'Consegnato', CodiceErrore: '', Descrizione: '' },
      Messaggio: '',
    }]);

    const result = await client.dettagliDocumento(creds, 'IDPRO000');

    expect(result).toEqual({ idPro: 'IDPRO000', stato: 'Consegnato', codiceErrore: '', descrizione: '' });
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano (modulo non esiste ancora)**

```bash
docker compose exec backend node_modules/.bin/jest globalcom-client --maxWorkers=2
```

Expected: FAIL con `Cannot find module './globalcom-client.service'`.

- [ ] **Step 3: Implementa `GlobalComClient`**

```ts
// apps/backend/src/channels/postal/globalcom-client.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as soap from 'soap';

export interface GbcAddress {
  denominazione1: string;
  denominazione2?: string;
  indirizzo1: string;
  indirizzo2?: string;
  cap?: string;
  citta: string;
  provincia?: string;
}

export interface GbcCredentials {
  baseUrl: string;
  user: string;
  password: string;
  group: string;
}

export interface GbcInvioParams {
  servizio: 'Lettera' | 'Raccomandata';
  ricevutaDiRitorno: boolean;
  mittente: GbcAddress | null;
  destinatario: GbcAddress;
  note: string;
  protocollo?: string;
  centroDiCosto?: string;
  userData1?: string;
  fileBuffer: Buffer;
}

export interface GbcDocStatus {
  idPro: string;
  stato: string;
  codiceErrore?: string;
  descrizione?: string;
}

function toInfoIndirizzoExt(addr: GbcAddress): Record<string, unknown> {
  return {
    Denominazione1: addr.denominazione1,
    ...(addr.denominazione2 ? { Denominazione2: addr.denominazione2 } : {}),
    Indirizzo1: addr.indirizzo1,
    ...(addr.indirizzo2 ? { Indirizzo2: addr.indirizzo2 } : {}),
    ...(addr.cap ? { CAP: addr.cap } : {}),
    Citta: addr.citta,
    ...(addr.provincia ? { Provincia: addr.provincia } : {}),
  };
}

function mapDocStatus(raw: any): GbcDocStatus {
  return {
    idPro: raw.IDPRO,
    stato: raw.Stato,
    codiceErrore: raw.CodiceErrore || undefined,
    descrizione: raw.Descrizione || undefined,
  };
}

/**
 * Unico punto che parla con il web service SOAP GlobalCom
 * (corrispondenzadigitale.it). Sessione a cookie ASP.NET: un client nuovo
 * per ogni operazione, Login seguito dalla chiamata reale sullo stesso
 * client — nessun riuso di sessione fra richieste diverse (stateless fra
 * pod). Verificato sul manuale tecnico ufficiale GlobalCom v5.26.
 */
@Injectable()
export class GlobalComClient {
  private readonly logger = new Logger(GlobalComClient.name);

  private async createSession(creds: GbcCredentials): Promise<soap.Client> {
    const client = await soap.createClientAsync(`${creds.baseUrl}?wsdl`, { endpoint: creds.baseUrl });
    const [loginResult] = await client.LoginAsync({ user: creds.user, password: creds.password, gruppo: creds.group });
    if (!loginResult.LoginResult) {
      throw new Error(`Login GlobalCom fallito: ${loginResult.message || 'credenziali non valide'}`);
    }
    const setCookie = (client as any).lastResponseHeaders?.['set-cookie'];
    if (setCookie) {
      const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
        .map((c: string) => c.split(';')[0])
        .join('; ');
      client.addHttpHeader('Cookie', cookie);
    }
    return client;
  }

  async invioExtSingolo(creds: GbcCredentials, params: GbcInvioParams): Promise<GbcDocStatus> {
    const client = await this.createSession(creds);
    const md5 = crypto.createHash('md5').update(params.fileBuffer).digest('hex').toUpperCase();

    const invio: Record<string, unknown> = {
      Servizio: params.servizio,
      RicevutaDiRitorno: params.ricevutaDiRitorno,
      Destinatari: [toInfoIndirizzoExt(params.destinatario)],
      Note: params.note,
      Files: [{
        file: params.fileBuffer.toString('base64'),
        filetype: 'pdf',
        MD5: md5,
        isreceipt: false,
        issigned: false,
      }],
      ...(params.mittente ? { Mittente: toInfoIndirizzoExt(params.mittente) } : { UsaMittentePredefinito: true }),
      ...(params.protocollo ? { Protocollo: params.protocollo } : {}),
      ...(params.centroDiCosto ? { CentrodiCosto: params.centroDiCosto } : {}),
      ...(params.userData1 ? { UserData1: params.userData1 } : {}),
    };

    const [result] = await (client as any).invio_ext_singoloAsync({ Invio: invio });
    if (!result.Result) {
      throw new Error(`invio_ext_singolo fallito: ${result.Messaggio || 'errore sconosciuto'}`);
    }
    return mapDocStatus(result.Risposta);
  }

  /** Ricerca testuale su PROTOCOLLO/LOTTO/NOTE — usata per il dedup su retry. */
  async cercaPerTesto(creds: GbcCredentials, testo: string): Promise<GbcDocStatus[]> {
    const client = await this.createSession(creds);
    const [result] = await (client as any).lista_documentiAsync({
      Filtri: { Testo: testo, SoloTesto: true, Limite: 1 },
    });
    const risposta = result.Risposta;
    if (!risposta) return [];
    const list = Array.isArray(risposta) ? risposta : [risposta];
    return list.map(mapDocStatus);
  }

  /** Poll-stato dedicato (manuale §2.2.10) — non presente nel solo WSDL. */
  async dettagliDocumento(creds: GbcCredentials, idPro: string): Promise<GbcDocStatus | null> {
    const client = await this.createSession(creds);
    const [result] = await (client as any).dettagli_documentoAsync({ IDPRO: idPro });
    if (!result.Result || !result.Risposta) return null;
    return mapDocStatus(result.Risposta);
  }
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest globalcom-client --maxWorkers=2
```

Expected: PASS, 6 test.

- [ ] **Step 5: Type-check e commit**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

```bash
git add apps/backend/src/channels/postal/globalcom-client.service.ts apps/backend/src/channels/postal/globalcom-client.service.spec.ts
git commit -m "feat(backend): aggiungi GlobalComClient (wrapper SOAP invio/ricerca/poll)"
```

---

## Task 4: `IChannelStrategy.send()` — parametro `attemptsMade`

**Files:**
- Modify: `apps/backend/src/channels/channel.interface.ts`
- Modify: `apps/backend/src/queue/notification.processor.ts:138,187`
- Test: `apps/backend/src/queue/notification.processor.spec.ts` (estendi, non riscrivi)

**Interfaces:**
- Produces: `IChannelStrategy.send(recipient, campaign, onLog?, attemptId?,
  attemptsMade?: number)` — consumato da `PostalStrategy` (Task 5) per il
  guard di dedup.

- [ ] **Step 1: Estendi l'interfaccia**

In `apps/backend/src/channels/channel.interface.ts`, sostituisci la firma di
`send`:

```ts
  /**
   * attemptId: id di NotificationAttempt (= BullMQ jobId), opzionale.
   * Usato dalle strategy che espongono un idempotence token verso il provider
   * esterno (es. SEND/PN) per far riconoscere una redelivery dello stesso job
   * come duplicato invece di generare un secondo invio reale.
   * attemptsMade: numero di tentativi BullMQ già fatti per questo job
   * (job.attemptsMade). 0 = primo tentativo. Usato da POSTAL per decidere se
   * verificare un eventuale invio già presente su GlobalCom prima di
   * reinviare (nessuna ambiguità al primo tentativo, solo sui retry).
   */
  send(recipient: Recipient, campaign: Campaign, onLog?: ChannelLogFn, attemptId?: string, attemptsMade?: number): Promise<ChannelSendResult>;
```

- [ ] **Step 2: Trova il punto in cui va aggiunto un test di regressione in `notification.processor.spec.ts`**

```bash
docker compose exec backend node_modules/.bin/jest notification.processor --maxWorkers=2 -t "attemptsMade"
```

Expected: FAIL (nessun test con questo nome ancora — verifica solo che il
comando giri senza errori di sintassi).

Apri `apps/backend/src/queue/notification.processor.spec.ts`, individua il
test esistente più vicino a `strategy.send` (grep `strategy.send` nel file)
e aggiungi, nello stesso `describe` in cui uno stub di `strategy` è già
mockato, questo test:

```ts
  it('passa job.attemptsMade a strategy.send()', async () => {
    // Riusa lo stesso setup (job/attempt/recipient/campaign mockati) del
    // test più vicino che verifica la chiamata a strategy.send esistente in
    // questo file — copia gli stessi mock di base, poi verifica in più:
    mockStrategy.send.mockResolvedValue({ messageId: 'm1', responsePayload: {} });
    // ... costruisci job con job.attemptsMade = 2 come fatto altrove nel file ...
    await processor.process(job as any);
    expect(mockStrategy.send).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), 2,
    );
  });
```

(L'implementatore deve adattare i mock esatti allo stile già presente nel
file — non duplicarli qui per non rischiare firme stantie; il contratto da
verificare è solo l'ultimo argomento passato a `strategy.send`.)

- [ ] **Step 3: Aggiorna la chiamata reale in `notification.processor.ts`**

Riga 138, sostituisci:

```ts
    const isMailChannel = channel === 'EMAIL' || channel === 'PEC';
```

con:

```ts
    const isMailChannel = channel === 'EMAIL' || channel === 'PEC' || channel === 'POSTAL';
```

Riga 187, sostituisci:

```ts
        primaryResult = await strategy.send(recipient, campaign, jobLog, attemptId);
```

con:

```ts
        primaryResult = await strategy.send(recipient, campaign, jobLog, attemptId, job.attemptsMade);
```

- [ ] **Step 4: Esegui la suite completa del processor**

```bash
docker compose exec backend node_modules/.bin/jest notification.processor --maxWorkers=2
```

Expected: PASS, incluso il nuovo test.

- [ ] **Step 5: Type-check e commit**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

```bash
git add apps/backend/src/channels/channel.interface.ts apps/backend/src/queue/notification.processor.ts apps/backend/src/queue/notification.processor.spec.ts
git commit -m "feat(backend): passa attemptsMade alle strategy, includi POSTAL nella co-delivery App IO"
```

---

## Task 5: `PostalStrategy` — invio reale

**Files:**
- Modify: `apps/backend/src/channels/postal/postal.strategy.ts`
- Modify: `apps/backend/src/channels/postal/postal.strategy.spec.ts`

**Interfaces:**
- Consumes: `GlobalComClient` (Task 3), `AppSettingsService.get<string>`,
  `AttachmentService.generatePdfBuffer(recipient, index)` (esistente),
  `resolvePhysicalAddress`/`getColumnValue` (esistenti in
  `payment-config.util.ts`), `resolveAttachmentsConfig` (esistente in
  `attachment.service.ts`).
- Produces: `ChannelSendResult { messageId: string; responsePayload:
  Record<string, unknown> }` — invariato, consumato dal processor esistente.

- [ ] **Step 1: Riscrivi il file di test**

```ts
// apps/backend/src/channels/postal/postal.strategy.spec.ts
import { Test } from '@nestjs/testing';
import { PostalStrategy } from './postal.strategy';
import { GlobalComClient } from './globalcom-client.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { AttachmentService } from '../../attachments/attachment.service';

describe('PostalStrategy', () => {
  let strategy: PostalStrategy;
  let globalCom: jest.Mocked<GlobalComClient>;
  let settings: jest.Mocked<AppSettingsService>;
  let attachments: jest.Mocked<AttachmentService>;

  const baseRecipient = {
    id: 'recipient-1',
    codiceFiscale: 'RSSMRA85M01H501Z',
    fullName: 'Mario Rossi',
    email: null,
    pec: null,
    extraData: { indirizzo: 'Via Roma 1', comune: 'Montesilvano', cap: '65015', prov: 'PE' },
  };

  const settingsMap: Record<string, unknown> = {
    'postal.baseUrl': 'https://esempio.corrispondenzadigitale.it/gbcweb/GBCWebservice.asmx',
    'postal.user': 'user1',
    'postal.password': 'pass1',
    'postal.group': 'group1',
    'postal.centroDiCosto': '',
    'postal.mittente.denominazione1': '',
    'postal.mittente.indirizzo1': '',
    'postal.mittente.cap': '',
    'postal.mittente.citta': '',
    'postal.mittente.provincia': '',
  };

  function baseCampaign(overrides: Record<string, unknown> = {}) {
    return {
      id: 'campaign-1',
      name: 'TARI 2026',
      channelConfig: {
        postalServiceType: 'Raccomandata',
        postalReturnReceipt: true,
        physicalAddressConfig: {
          enabled: true,
          addressColumn: 'indirizzo',
          municipalityColumn: 'comune',
          zipColumn: 'cap',
          provinceColumn: 'prov',
        },
        ...overrides,
      },
    };
  }

  beforeEach(async () => {
    const mockGlobalCom = {
      invioExtSingolo: jest.fn(),
      cercaPerTesto: jest.fn(),
      dettagliDocumento: jest.fn(),
    };
    const mockSettings = { get: jest.fn(async (key: string) => settingsMap[key]) };
    const mockAttachments = { generatePdfBuffer: jest.fn(async () => Buffer.from('%PDF-1.4 test')) };

    const module = await Test.createTestingModule({
      providers: [
        PostalStrategy,
        { provide: GlobalComClient, useValue: mockGlobalCom },
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: AttachmentService, useValue: mockAttachments },
      ],
    }).compile();

    strategy = module.get(PostalStrategy);
    globalCom = module.get(GlobalComClient);
    settings = module.get(AppSettingsService) as any;
    attachments = module.get(AttachmentService) as any;
  });

  it('is defined with channel POSTAL', () => {
    expect(strategy.channel).toBe('POSTAL');
  });

  it('send() invia via GlobalCom e ritorna messageId=IDPRO', async () => {
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO123', stato: 'Accettato' });

    const result = await strategy.send(baseRecipient as never, baseCampaign() as never, undefined, 'attempt-uuid-1', 0);

    expect(attachments.generatePdfBuffer).toHaveBeenCalledWith(baseRecipient, 0);
    expect(globalCom.invioExtSingolo).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: settingsMap['postal.baseUrl'], user: 'user1' }),
      expect.objectContaining({
        servizio: 'Raccomandata',
        ricevutaDiRitorno: true,
        mittente: null,
        note: 'attempt-uuid-1',
        destinatario: expect.objectContaining({ indirizzo1: 'Via Roma 1', citta: 'Montesilvano', cap: '65015', provincia: 'PE' }),
      }),
    );
    expect(result.messageId).toBe('IDPRO123');
    expect(result.responsePayload).toEqual({ stato: 'Accettato', idPro: 'IDPRO123' });
  });

  it('send() lancia se indirizzo destinatario non risolvibile', async () => {
    const recipientSenzaIndirizzo = { ...baseRecipient, extraData: {} };

    await expect(
      strategy.send(recipientSenzaIndirizzo as never, baseCampaign() as never, undefined, 'attempt-uuid-2', 0),
    ).rejects.toThrow(/indirizzo destinatario non risolvibile/);
    expect(globalCom.invioExtSingolo).not.toHaveBeenCalled();
  });

  it('send() lancia se GlobalCom risponde Stato=Errore', async () => {
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO999', stato: 'Errore', codiceErrore: 'E01', descrizione: 'CAP non valido' });

    await expect(
      strategy.send(baseRecipient as never, baseCampaign() as never, undefined, 'attempt-uuid-3', 0),
    ).rejects.toThrow(/CAP non valido/);
  });

  it('send() al primo tentativo (attemptsMade=0) NON cerca dedup su GlobalCom', async () => {
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Accettato' });

    await strategy.send(baseRecipient as never, baseCampaign() as never, undefined, 'attempt-uuid-4', 0);

    expect(globalCom.cercaPerTesto).not.toHaveBeenCalled();
  });

  it('send() su retry (attemptsMade>0) trova un invio già presente e non reinvia', async () => {
    globalCom.cercaPerTesto.mockResolvedValue([{ idPro: 'IDPRO-ESISTENTE', stato: 'Consegnato' }]);

    const result = await strategy.send(baseRecipient as never, baseCampaign() as never, undefined, 'attempt-uuid-5', 1);

    expect(globalCom.cercaPerTesto).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: settingsMap['postal.baseUrl'] }),
      'attempt-uuid-5',
    );
    expect(globalCom.invioExtSingolo).not.toHaveBeenCalled();
    expect(result.messageId).toBe('IDPRO-ESISTENTE');
  });

  it('send() su retry con solo esiti Errore/Eliminato precedenti reinvia normalmente', async () => {
    globalCom.cercaPerTesto.mockResolvedValue([{ idPro: 'IDPRO-VECCHIO', stato: 'Errore' }]);
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO-NUOVO', stato: 'Accettato' });

    const result = await strategy.send(baseRecipient as never, baseCampaign() as never, undefined, 'attempt-uuid-6', 1);

    expect(globalCom.invioExtSingolo).toHaveBeenCalled();
    expect(result.messageId).toBe('IDPRO-NUOVO');
  });

  it('send() usa Mittente esplicito se configurato nelle settings', async () => {
    settingsMap['postal.mittente.denominazione1'] = 'Comune di Montesilvano';
    settingsMap['postal.mittente.indirizzo1'] = 'Via Roma 1';
    settingsMap['postal.mittente.cap'] = '65016';
    settingsMap['postal.mittente.citta'] = 'Montesilvano';
    settingsMap['postal.mittente.provincia'] = 'PE';
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Accettato' });

    await strategy.send(baseRecipient as never, baseCampaign() as never, undefined, 'attempt-uuid-7', 0);

    expect(globalCom.invioExtSingolo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mittente: expect.objectContaining({ denominazione1: 'Comune di Montesilvano' }) }),
    );

    settingsMap['postal.mittente.denominazione1'] = '';
    settingsMap['postal.mittente.indirizzo1'] = '';
    settingsMap['postal.mittente.cap'] = '';
    settingsMap['postal.mittente.citta'] = '';
    settingsMap['postal.mittente.provincia'] = '';
  });

  it('send() passa UserData1 da userDataColumn quando configurato', async () => {
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Accettato' });
    const recipientConCodice = { ...baseRecipient, extraData: { ...baseRecipient.extraData, numero_avviso: 'AV-2026-001' } };

    await strategy.send(
      recipientConCodice as never,
      baseCampaign({ userDataColumn: 'numero_avviso' }) as never,
      undefined, 'attempt-uuid-8', 0,
    );

    expect(globalCom.invioExtSingolo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userData1: 'AV-2026-001' }),
    );
  });

  it('send() passa Protocollo se protocollazione già avvenuta', async () => {
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Accettato' });
    const recipientConProtocollo = { ...baseRecipient, protocolNumber: '42/2026' };

    await strategy.send(recipientConProtocollo as never, baseCampaign() as never, undefined, 'attempt-uuid-9', 0);

    expect(globalCom.invioExtSingolo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ protocollo: '42/2026' }),
    );
  });
});
```

Nota: il test "passa Protocollo" assume che il numero di protocollo arrivi
sul `recipient` come `recipient.protocolNumber` — coerente con
`notification.processor.ts:126-128`, che copia
`existingAttempt.protocolNumber/protocolYear` già formattati come stringa
`"${n}/${y}"` su `(recipient as any).protocolNumber` prima di chiamare
`strategy.send()`. `PostalStrategy` legge quel campo, non
`attempt.protocolNumber` direttamente (a differenza di SEND, che gira fuori
da questo processor).

- [ ] **Step 2: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest postal.strategy --maxWorkers=2
```

Expected: FAIL (implementazione ancora vecchia, mock providers non
corrispondono).

- [ ] **Step 3: Riscrivi `PostalStrategy`**

```ts
// apps/backend/src/channels/postal/postal.strategy.ts
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel, ChannelSendResult } from '@comunicapa/shared-types';
import type { ChannelLogFn, IChannelStrategy } from '../channel.interface';
import type { Recipient } from '../../entities/recipient.entity';
import type { Campaign } from '../../entities/campaign.entity';
import { AppSettingsService } from '../../settings/app-settings.service';
import type { SettingKey } from '../../settings/settings.registry';
import { AttachmentService } from '../../attachments/attachment.service';
import { GlobalComClient, type GbcAddress, type GbcCredentials } from './globalcom-client.service';
import { getColumnValue, resolvePhysicalAddress } from '../payment-config.util';

const NON_TERMINAL_DEDUP_STATI = ['Errore', 'Eliminato'];

@Injectable()
export class PostalStrategy implements IChannelStrategy {
  private readonly logger = new Logger(PostalStrategy.name);
  readonly channel: NotificationChannel = 'POSTAL';

  constructor(
    private readonly globalCom: GlobalComClient,
    private readonly settings: AppSettingsService,
    private readonly attachments: AttachmentService,
  ) {}

  private async loadCredentials(): Promise<GbcCredentials> {
    return {
      baseUrl: await this.settings.get<string>('postal.baseUrl'),
      user: await this.settings.get<string>('postal.user'),
      password: await this.settings.get<string>('postal.password'),
      group: await this.settings.get<string>('postal.group'),
    };
  }

  private async loadMittente(): Promise<GbcAddress | null> {
    const denominazione1 = await this.settings.get<string>('postal.mittente.denominazione1');
    if (!denominazione1) return null;
    return {
      denominazione1,
      indirizzo1: await this.settings.get<string>('postal.mittente.indirizzo1'),
      cap: (await this.settings.get<string>('postal.mittente.cap')) || undefined,
      citta: await this.settings.get<string>('postal.mittente.citta'),
      provincia: (await this.settings.get<string>('postal.mittente.provincia')) || undefined,
    };
  }

  async send(
    recipient: Recipient,
    campaign: Campaign,
    onLog?: ChannelLogFn,
    attemptId?: string,
    attemptsMade?: number,
  ): Promise<ChannelSendResult> {
    const log = (msg: string): void => {
      this.logger.debug(msg);
      onLog?.(msg);
    };

    const cfg = campaign.channelConfig as Record<string, unknown>;
    const creds = await this.loadCredentials();

    // Dedup: il rischio di doppio invio/doppio addebito esiste solo sui
    // retry (job.attemptsMade > 0) — al primo tentativo non può esistere
    // ancora nulla su GlobalCom per questo attempt. Verificato contro il
    // database di GlobalCom stesso (Note = attemptId), non contro il nostro,
    // vedi design doc.
    if (attemptsMade && attemptsMade > 0 && attemptId) {
      const trovati = await this.globalCom.cercaPerTesto(creds, attemptId);
      const esistente = trovati.find((d) => !NON_TERMINAL_DEDUP_STATI.includes(d.stato));
      if (esistente) {
        const msg = `Invio già presente su GlobalCom per attempt ${attemptId} (IDPRO=${esistente.idPro}, stato=${esistente.stato}) — salto reinvio duplicato.`;
        this.logger.warn(msg);
        log(msg);
        return { messageId: esistente.idPro, responsePayload: { stato: esistente.stato, idPro: esistente.idPro, dedup: true } };
      }
    }

    const physicalAddressConfig = cfg['physicalAddressConfig'] as Record<string, unknown> | undefined;
    const resolvedAddress = resolvePhysicalAddress(recipient, physicalAddressConfig);
    if (!resolvedAddress) {
      throw new BadRequestException('Indirizzo destinatario non risolvibile: verifica mapping colonne CSV in configurazione canale POSTAL');
    }

    const destinatario: GbcAddress = {
      denominazione1: recipient.fullName || recipient.codiceFiscale,
      indirizzo1: resolvedAddress.address,
      cap: resolvedAddress.zip,
      citta: resolvedAddress.municipality,
      provincia: resolvedAddress.province,
    };

    const servizio = ((cfg['postalServiceType'] as string) || 'Raccomandata') as 'Lettera' | 'Raccomandata';
    const ricevutaDiRitorno = servizio === 'Raccomandata' && !!cfg['postalReturnReceipt'];

    const userDataColumn = cfg['userDataColumn'] as string | undefined;
    const userData1 = userDataColumn ? getColumnValue(recipient, userDataColumn) || undefined : undefined;

    const protocollo = (recipient as unknown as { protocolNumber?: string }).protocolNumber;

    const fileBuffer = await this.attachments.generatePdfBuffer(recipient, 0);
    const mittente = await this.loadMittente();
    const centroDiCosto = (await this.settings.get<string>('postal.centroDiCosto')) || undefined;

    log(`Invio POSTAL (GlobalCom) a ${recipient.codiceFiscale}: servizio=${servizio}, AR=${ricevutaDiRitorno}`);

    const risposta = await this.globalCom.invioExtSingolo(creds, {
      servizio,
      ricevutaDiRitorno,
      mittente,
      destinatario,
      note: attemptId || `${campaign.name}-${recipient.codiceFiscale}`,
      protocollo,
      centroDiCosto,
      userData1,
      fileBuffer,
    });

    if (risposta.stato === 'Errore') {
      throw new Error(`Invio GlobalCom in errore (${risposta.codiceErrore || '??'}): ${risposta.descrizione || 'nessun dettaglio'}`);
    }

    this.logger.log(`Invio POSTAL riuscito per CF ${recipient.codiceFiscale}: IDPRO=${risposta.idPro}, stato=${risposta.stato}`);
    log(`Risposta GlobalCom: IDPRO=${risposta.idPro}, stato=${risposta.stato}`);

    return {
      messageId: risposta.idPro,
      responsePayload: { stato: risposta.stato, idPro: risposta.idPro },
    };
  }
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest postal.strategy --maxWorkers=2
```

Expected: PASS, 10 test.

- [ ] **Step 5: Type-check**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Se emerge un errore sul tipo di `postalTrackingId`/`messageId` — nessuno
atteso, `ChannelSendResult.messageId` è già `string`.

- [ ] **Step 6: Registra `PostalStrategy` con le nuove dipendenze in `channel.module.ts`**

In `apps/backend/src/channels/channel.module.ts`:
- Rimuovi l'import di `PdfModule` se non più usato da nessun'altra strategy
  (verifica con `grep -rn "PdfModule\|PdfService" apps/backend/src/channels/`
  prima di rimuoverlo — non rimuovere se qualcos'altro lo usa ancora).
- Aggiungi `GlobalComClient` ai `providers`.

```ts
import { GlobalComClient } from './postal/globalcom-client.service';
```

Nell'array `providers: [...]`, aggiungi `GlobalComClient` (prima di
`PostalStrategy`, che ora lo inietta).

- [ ] **Step 7: Avvia il backend e verifica che parta senza errori di DI**

```bash
docker compose up -d --build backend
docker compose logs backend --tail 50
```

Expected: nessun errore `Nest can't resolve dependencies of PostalStrategy`.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/channels/postal/postal.strategy.ts apps/backend/src/channels/postal/postal.strategy.spec.ts apps/backend/src/channels/channel.module.ts
git commit -m "feat(backend): PostalStrategy invia realmente via GlobalCom (login+invio_ext_singolo+dedup retry)"
```

---

## Task 6: `PostalStatusSyncService` — poll consegna

**Files:**
- Create: `apps/backend/src/channels/postal/postal-status-sync.service.ts`
- Create: `apps/backend/src/channels/postal/postal-status-sync.service.spec.ts`
- Modify: `apps/backend/src/channels/channel.module.ts`

**Interfaces:**
- Consumes: `GlobalComClient.dettagliDocumento` (Task 3),
  `NotificationAttempt.postalTrackingId/postalStatus/postalStatusUpdatedAt`
  (Task 1).

- [ ] **Step 1: Scrivi il test**

```ts
// apps/backend/src/channels/postal/postal-status-sync.service.spec.ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PostalStatusSyncService } from './postal-status-sync.service';
import { GlobalComClient } from './globalcom-client.service';
import { AppSettingsService } from '../../settings/app-settings.service';
import { NotificationAttempt } from '../../entities/notification-attempt.entity';

describe('PostalStatusSyncService', () => {
  let service: PostalStatusSyncService;
  let globalCom: jest.Mocked<GlobalComClient>;
  let attemptRepo: { find: jest.Mock; save: jest.Mock; createQueryBuilder: jest.Mock };

  const settingsMap: Record<string, unknown> = {
    'postal.baseUrl': 'https://esempio.corrispondenzadigitale.it/gbcweb/GBCWebservice.asmx',
    'postal.user': 'u', 'postal.password': 'p', 'postal.group': 'g',
  };

  function makeQueryBuilder(rows: any[]) {
    const qb: any = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(rows),
    };
    return qb;
  }

  beforeEach(async () => {
    const mockGlobalCom = { dettagliDocumento: jest.fn(), invioExtSingolo: jest.fn(), cercaPerTesto: jest.fn() };
    const mockSettings = { get: jest.fn(async (key: string) => settingsMap[key]) };
    attemptRepo = { find: jest.fn(), save: jest.fn(), createQueryBuilder: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        PostalStatusSyncService,
        { provide: GlobalComClient, useValue: mockGlobalCom },
        { provide: AppSettingsService, useValue: mockSettings },
        { provide: getRepositoryToken(NotificationAttempt), useValue: attemptRepo },
      ],
    }).compile();

    service = module.get(PostalStatusSyncService);
    globalCom = module.get(GlobalComClient) as any;
  });

  it('non fa nulla se non ci sono attempt candidati', async () => {
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([]));

    await service.handleCron();

    expect(globalCom.dettagliDocumento).not.toHaveBeenCalled();
  });

  it('aggiorna postalStatus quando lo stato è cambiato', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Accettato', postalStatusUpdatedAt: null };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Consegnato' });

    await service.handleCron();

    expect(globalCom.dettagliDocumento).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: settingsMap['postal.baseUrl'] }),
      'IDPRO1',
    );
    expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', postalStatus: 'Consegnato' }));
  });

  it('non salva se lo stato non è cambiato', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Inviato', postalStatusUpdatedAt: null };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Inviato' });

    await service.handleCron();

    expect(attemptRepo.save).not.toHaveBeenCalled();
  });

  it('logga e continua se dettagliDocumento fallisce per un attempt, senza bloccare gli altri', async () => {
    const attempt1 = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Inviato', postalStatusUpdatedAt: null };
    const attempt2 = { id: 'a2', postalTrackingId: 'IDPRO2', postalStatus: 'Inviato', postalStatusUpdatedAt: null };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt1, attempt2]));
    globalCom.dettagliDocumento
      .mockRejectedValueOnce(new Error('timeout SOAP'))
      .mockResolvedValueOnce({ idPro: 'IDPRO2', stato: 'Consegnato' });

    await service.handleCron();

    expect(attemptRepo.save).toHaveBeenCalledTimes(1);
    expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'a2', postalStatus: 'Consegnato' }));
  });
});
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest postal-status-sync --maxWorkers=2
```

Expected: FAIL, `Cannot find module './postal-status-sync.service'`.

- [ ] **Step 3: Implementa `PostalStatusSyncService`**

```ts
// apps/backend/src/channels/postal/postal-status-sync.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { NotificationAttempt, AttemptStatus } from '../../entities/notification-attempt.entity';
import { AppSettingsService } from '../../settings/app-settings.service';
import { GlobalComClient, type GbcCredentials } from './globalcom-client.service';

const BATCH_SIZE = 200;
// GBCStatus terminali (manuale §3.1) — tutti gli altri sono transitori e
// vanno ricontrollati al prossimo giro.
const TERMINAL_STATUSES = ['Consegnato', 'NonConsegnato', 'ConsegnaParziale', 'Errore', 'Eliminato'];

/**
 * Demone di poll consegna per il canale POSTAL/GlobalCom — nessuna chiamata
 * a CampaignCompletionService.checkAndComplete(): il completamento campagna
 * è già deciso a livello di submission dal NotificationProcessor BullMQ
 * standard (PostalStrategy resta su BullMQ, a differenza di SEND). Qui si
 * aggiorna solo lo stato di consegna downstream, puramente informativo.
 */
@Injectable()
export class PostalStatusSyncService {
  private readonly logger = new Logger(PostalStatusSyncService.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    private readonly settings: AppSettingsService,
    private readonly globalCom: GlobalComClient,
  ) {}

  @Cron('*/5 * * * *')
  async handleCron(): Promise<void> {
    const attempts = await this.attemptRepo
      .createQueryBuilder('attempt')
      .where('attempt.channel_type = :ch', { ch: 'POSTAL' })
      .andWhere('attempt.status = :status', { status: AttemptStatus.SUCCESS })
      .andWhere('attempt.postal_tracking_id IS NOT NULL')
      .andWhere('(attempt.postal_status IS NULL OR attempt.postal_status NOT IN (:...terminal))', { terminal: TERMINAL_STATUSES })
      .orderBy('attempt.created_at', 'ASC')
      .take(BATCH_SIZE)
      .getMany();

    if (attempts.length === 0) return;

    const creds: GbcCredentials = {
      baseUrl: await this.settings.get<string>('postal.baseUrl'),
      user: await this.settings.get<string>('postal.user'),
      password: await this.settings.get<string>('postal.password'),
      group: await this.settings.get<string>('postal.group'),
    };

    for (const attempt of attempts) {
      try {
        const stato = await this.globalCom.dettagliDocumento(creds, attempt.postalTrackingId!);
        if (stato && stato.stato !== attempt.postalStatus) {
          attempt.postalStatus = stato.stato;
          attempt.postalStatusUpdatedAt = new Date();
          await this.attemptRepo.save(attempt);
        }
      } catch (err: any) {
        this.logger.warn(`Errore aggiornamento stato POSTAL per attempt ${attempt.id} (IDPRO=${attempt.postalTrackingId}): ${err.message}`);
      }
    }
  }
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest postal-status-sync --maxWorkers=2
```

Expected: PASS, 4 test.

- [ ] **Step 5: Registra il servizio in `channel.module.ts`**

```ts
import { PostalStatusSyncService } from './postal/postal-status-sync.service';
```

Aggiungi `PostalStatusSyncService` all'array `providers: [...]`.

- [ ] **Step 6: Verifica che `ScheduleModule` sia già attivo globalmente**

```bash
grep -rn "ScheduleModule" apps/backend/src/app.module.ts
```

Expected: presente (già richiesto da `SendDispatchService`/
`SendStatusSyncService` esistenti) — se assente, aggiungere
`ScheduleModule.forRoot()` agli imports di `app.module.ts` (non dovrebbe
servire, verifica soltanto).

- [ ] **Step 7: Type-check, avvio e commit**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose up -d --build backend
docker compose logs backend --tail 50
```

Expected: nessun errore, log periodico assente finché non ci sono attempt
POSTAL SUCCESS con `postalTrackingId` (normale, nessun dato ancora).

```bash
git add apps/backend/src/channels/postal/postal-status-sync.service.ts apps/backend/src/channels/postal/postal-status-sync.service.spec.ts apps/backend/src/channels/channel.module.ts
git commit -m "feat(backend): aggiungi PostalStatusSyncService (poll stato consegna GlobalCom)"
```

---

## Task 7: Suite completa backend — verifica di non regressione

**Files:** nessuno (solo verifica)

- [ ] **Step 1: Esegui l'intera suite backend**

```bash
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

Expected: nessun fallimento nuovo rispetto alla baseline pulita (vedi
CLAUDE.md, sezione Test) — se emerge un fallimento in un file non toccato da
questo piano, è una regressione da investigare prima di proseguire, non da
ignorare.

- [ ] **Step 2: Type-check completo**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Expected: nessun errore.

---

## Task 8: Frontend — settings tab Postal

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: chiavi settings `postal.*` (Task 2).

- [ ] **Step 1: Localizza gli anchor esatti (il file cambia spesso, verifica prima di editare)**

```bash
grep -n "settSendEnvironment\|'send.environment': settSendEnvironment\|settSendTestBaseUrl, setSettSendTestBaseUrl" apps/frontend-admin/src/App.tsx
```

Annota i numeri di riga correnti per: (a) blocco `useState` dei campi SEND
settings, (b) blocco payload di salvataggio (`'send.environment':
settSendEnvironment`), (c) blocco caricamento (`setSettSendEnvironment(...)`
da risposta GET), (d) il JSX della tab Impostazioni → SEND (cerca il testo
`Impostazioni SEND` o simile con `grep -n "SEND" apps/frontend-admin/src/App.tsx | grep -i tab`).

- [ ] **Step 2: Aggiungi gli state React (vicino ai blocchi `settSend*`)**

```tsx
  const [settPostalBaseUrl, setSettPostalBaseUrl] = useState('');
  const [settPostalUser, setSettPostalUser] = useState('');
  const [settPostalPassword, setSettPostalPassword] = useState('');
  const [settPostalGroup, setSettPostalGroup] = useState('');
  const [settPostalCentroDiCosto, setSettPostalCentroDiCosto] = useState('');
  const [settPostalMittenteDenominazione1, setSettPostalMittenteDenominazione1] = useState('');
  const [settPostalMittenteIndirizzo1, setSettPostalMittenteIndirizzo1] = useState('');
  const [settPostalMittenteCap, setSettPostalMittenteCap] = useState('');
  const [settPostalMittenteCitta, setSettPostalMittenteCitta] = useState('');
  const [settPostalMittenteProvincia, setSettPostalMittenteProvincia] = useState('');
```

- [ ] **Step 3: Aggiungi il caricamento (stesso blocco che popola `setSettSendEnvironment` da GET settings)**

```tsx
      setSettPostalBaseUrl(data['postal.baseUrl'] ?? '');
      setSettPostalUser(data['postal.user'] ?? '');
      setSettPostalPassword(data['postal.password'] ?? '');
      setSettPostalGroup(data['postal.group'] ?? '');
      setSettPostalCentroDiCosto(data['postal.centroDiCosto'] ?? '');
      setSettPostalMittenteDenominazione1(data['postal.mittente.denominazione1'] ?? '');
      setSettPostalMittenteIndirizzo1(data['postal.mittente.indirizzo1'] ?? '');
      setSettPostalMittenteCap(data['postal.mittente.cap'] ?? '');
      setSettPostalMittenteCitta(data['postal.mittente.citta'] ?? '');
      setSettPostalMittenteProvincia(data['postal.mittente.provincia'] ?? '');
```

(Adatta il nome della variabile `data`/risposta al pattern esatto già usato
nel blocco SEND circostante — stessa fonte, stesso formato chiave→valore.)

- [ ] **Step 4: Aggiungi il payload di salvataggio (stesso blocco `'send.environment': settSendEnvironment`)**

```tsx
    'postal.baseUrl': settPostalBaseUrl,
    'postal.user': settPostalUser,
    'postal.password': settPostalPassword,
    'postal.group': settPostalGroup,
    'postal.centroDiCosto': settPostalCentroDiCosto,
    'postal.mittente.denominazione1': settPostalMittenteDenominazione1,
    'postal.mittente.indirizzo1': settPostalMittenteIndirizzo1,
    'postal.mittente.cap': settPostalMittenteCap,
    'postal.mittente.citta': settPostalMittenteCitta,
    'postal.mittente.provincia': settPostalMittenteProvincia,
```

- [ ] **Step 5: Aggiungi la sezione JSX (mirror della sezione SEND, stesso pattern di card/input)**

Individua la card "Impostazioni SEND" con `grep -n "Impostazioni SEND\|h5.*SEND" apps/frontend-admin/src/App.tsx`
e aggiungi, subito dopo la sua chiusura, un blocco analogo:

```tsx
                <div className="card mb-4">
                  <div className="card-header fw-bold">Postalizzazione (GlobalCom)</div>
                  <div className="card-body">
                    <div className="row g-3">
                      <div className="col-md-8">
                        <label className="form-label small fw-bold">URL Web Service (WSDL)</label>
                        <input className="form-control" placeholder="https://<comune>.corrispondenzadigitale.it/gbcweb/GBCWebservice.asmx"
                          value={settPostalBaseUrl} onChange={(e) => setSettPostalBaseUrl(e.target.value)} />
                      </div>
                      <div className="col-md-4">
                        <label className="form-label small fw-bold">Centro di Costo</label>
                        <input className="form-control" value={settPostalCentroDiCosto} onChange={(e) => setSettPostalCentroDiCosto(e.target.value)} />
                      </div>
                      <div className="col-md-4">
                        <label className="form-label small fw-bold">Utente</label>
                        <input className="form-control" value={settPostalUser} onChange={(e) => setSettPostalUser(e.target.value)} />
                      </div>
                      <div className="col-md-4">
                        <label className="form-label small fw-bold">Password</label>
                        <input type="password" className="form-control" value={settPostalPassword} onChange={(e) => setSettPostalPassword(e.target.value)} />
                      </div>
                      <div className="col-md-4">
                        <label className="form-label small fw-bold">Gruppo</label>
                        <input className="form-control" placeholder="<DEFAULT> se utenza spare" value={settPostalGroup} onChange={(e) => setSettPostalGroup(e.target.value)} />
                      </div>
                      <div className="col-12"><hr /><span className="small text-muted fw-bold">Mittente (opzionale — vuoto = mittente predefinito utenza GlobalCom)</span></div>
                      <div className="col-md-6">
                        <label className="form-label small">Denominazione</label>
                        <input className="form-control" value={settPostalMittenteDenominazione1} onChange={(e) => setSettPostalMittenteDenominazione1(e.target.value)} />
                      </div>
                      <div className="col-md-6">
                        <label className="form-label small">Indirizzo</label>
                        <input className="form-control" value={settPostalMittenteIndirizzo1} onChange={(e) => setSettPostalMittenteIndirizzo1(e.target.value)} />
                      </div>
                      <div className="col-md-4">
                        <label className="form-label small">CAP</label>
                        <input className="form-control" value={settPostalMittenteCap} onChange={(e) => setSettPostalMittenteCap(e.target.value)} />
                      </div>
                      <div className="col-md-4">
                        <label className="form-label small">Città</label>
                        <input className="form-control" value={settPostalMittenteCitta} onChange={(e) => setSettPostalMittenteCitta(e.target.value)} />
                      </div>
                      <div className="col-md-4">
                        <label className="form-label small">Provincia</label>
                        <input className="form-control" maxLength={2} value={settPostalMittenteProvincia} onChange={(e) => setSettPostalMittenteProvincia(e.target.value.toUpperCase())} />
                      </div>
                    </div>
                  </div>
                </div>
```

- [ ] **Step 6: Type-check frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 7: Verifica manuale nel browser**

```bash
docker compose up -d frontend-admin
```

Apri `http://localhost:3000`, login admin (`admin`/`admin` con
`LDAP_HOST=mock`), vai su Impostazioni → verifica che la card
"Postalizzazione (GlobalCom)" compaia, compila i campi, salva, ricarica la
pagina e verifica che i valori persistano (tranne `password`, mascherata).

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend): aggiungi tab Impostazioni Postalizzazione (GlobalCom)"
```

---

## Task 9: Frontend — campi wizard canale POSTAL

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Produces: `channelConfig.postalServiceType`,
  `channelConfig.postalReturnReceipt`, `channelConfig.physicalAddressConfig`,
  `channelConfig.userDataColumn` — consumati da `PostalStrategy` (Task 5).

- [ ] **Step 1: Localizza il blocco condizionale SEND nel wizard**

```bash
grep -n "wizChannel === 'SEND'" apps/frontend-admin/src/App.tsx
```

Individua in particolare la riga ~3852 (`{wizChannel === 'SEND' && (`, campi
taxonomyCode/physicalCommunicationType) e la riga ~2678/2807 (dove
`channelConfig` viene assemblato prima del submit, branch `if (wizChannel
=== 'SEND')`).

- [ ] **Step 2: Aggiungi gli state React per i nuovi campi**

```tsx
  const [wizPostalServiceType, setWizPostalServiceType] = useState<'Raccomandata' | 'Lettera'>('Raccomandata');
  const [wizPostalReturnReceipt, setWizPostalReturnReceipt] = useState(true);
  const [wizPostalAddressColumn, setWizPostalAddressColumn] = useState('');
  const [wizPostalMunicipalityColumn, setWizPostalMunicipalityColumn] = useState('');
  const [wizPostalZipColumn, setWizPostalZipColumn] = useState('');
  const [wizPostalProvinceColumn, setWizPostalProvinceColumn] = useState('');
  const [wizPostalUserDataColumn, setWizPostalUserDataColumn] = useState('');
```

- [ ] **Step 3: Aggiungi il blocco JSX condizionale, mirror del blocco `wizChannel === 'SEND'` trovato allo Step 1**

```tsx
                  {wizChannel === 'POSTAL' && (
                    <div className="row g-3 mb-3">
                      <div className="col-md-4">
                        <label className="form-label small fw-bold">Tipo di invio</label>
                        <select className="form-select" value={wizPostalServiceType}
                          onChange={(e) => setWizPostalServiceType(e.target.value as 'Raccomandata' | 'Lettera')}>
                          <option value="Raccomandata">Raccomandata</option>
                          <option value="Lettera">Lettera (ordinaria)</option>
                        </select>
                      </div>
                      {wizPostalServiceType === 'Raccomandata' && (
                        <div className="col-md-4 d-flex align-items-end">
                          <div className="form-check">
                            <input className="form-check-input" type="checkbox" id="wizPostalAR"
                              checked={wizPostalReturnReceipt} onChange={(e) => setWizPostalReturnReceipt(e.target.checked)} />
                            <label className="form-check-label small" htmlFor="wizPostalAR">Ricevuta di ritorno (AR)</label>
                          </div>
                        </div>
                      )}
                      <div className="col-12"><hr /><span className="small text-muted fw-bold">Indirizzo destinatario (colonne CSV)</span></div>
                      <div className="col-md-3">
                        <label className="form-label small">Colonna indirizzo *</label>
                        <input className="form-control" placeholder="es. indirizzo" value={wizPostalAddressColumn} onChange={(e) => setWizPostalAddressColumn(e.target.value)} />
                      </div>
                      <div className="col-md-3">
                        <label className="form-label small">Colonna città *</label>
                        <input className="form-control" placeholder="es. comune" value={wizPostalMunicipalityColumn} onChange={(e) => setWizPostalMunicipalityColumn(e.target.value)} />
                      </div>
                      <div className="col-md-2">
                        <label className="form-label small">Colonna CAP</label>
                        <input className="form-control" placeholder="es. cap" value={wizPostalZipColumn} onChange={(e) => setWizPostalZipColumn(e.target.value)} />
                      </div>
                      <div className="col-md-2">
                        <label className="form-label small">Colonna provincia</label>
                        <input className="form-control" placeholder="es. prov" value={wizPostalProvinceColumn} onChange={(e) => setWizPostalProvinceColumn(e.target.value)} />
                      </div>
                      <div className="col-12"><hr /><span className="small text-muted fw-bold">Riconciliazione gestionale tributi (opzionale)</span></div>
                      <div className="col-md-4">
                        <label className="form-label small">Colonna riferimento (UserData1)</label>
                        <input className="form-control" placeholder="es. numero_avviso" value={wizPostalUserDataColumn} onChange={(e) => setWizPostalUserDataColumn(e.target.value)} />
                      </div>
                    </div>
                  )}
```

- [ ] **Step 4: Aggiungi il branch di assemblaggio `channelConfig` (stesso blocco `else if (wizChannel === 'SEND')` trovato allo Step 1)**

```tsx
    } else if (wizChannel === 'POSTAL') {
      channelConfig.postalServiceType = wizPostalServiceType;
      channelConfig.postalReturnReceipt = wizPostalReturnReceipt;
      channelConfig.physicalAddressConfig = {
        enabled: true,
        addressColumn: wizPostalAddressColumn,
        municipalityColumn: wizPostalMunicipalityColumn,
        zipColumn: wizPostalZipColumn,
        provinceColumn: wizPostalProvinceColumn,
      };
      if (wizPostalUserDataColumn) {
        channelConfig.userDataColumn = wizPostalUserDataColumn;
      }
```

(Adatta la sintassi esatta — `else if`/chiusura graffe — allo stile del
blocco `if/else if` già presente per gli altri canali nello stesso punto.)

- [ ] **Step 5: Type-check frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 6: Verifica manuale nel browser**

Crea una campagna di test dal wizard con canale POSTAL, verifica che i nuovi
campi compaiano al passo di configurazione canale, compila e completa il
wizard fino al salvataggio bozza; apri la bozza da "Riprendi wizard" e
verifica che i valori siano stati persistiti in `channelConfig`.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend): aggiungi campi wizard canale POSTAL (tipo invio, indirizzo, riferimento tributi)"
```

---

## Task 10: Frontend — badge stato e dettaglio consegna

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

- [ ] **Step 1: Localizza `SEND_STATUS_META`/`SendStatusBadge` e i punti di rendering**

```bash
grep -n "SEND_STATUS_META\|SendStatusBadge\|a.sendStatus\|r.sendStatus" apps/frontend-admin/src/App.tsx
```

- [ ] **Step 2: Aggiungi `POSTAL_STATUS_META` e `PostalStatusBadge` subito dopo il blocco `SendStatusBadge`**

```tsx
const POSTAL_STATUS_META: Record<string, { label: string; badge: string; icon: string }> = {
  Accettato: { label: 'Accettato', badge: 'bg-secondary-subtle text-secondary-emphasis border', icon: 'fa-inbox' },
  Sospeso: { label: 'Sospeso', badge: 'bg-secondary-subtle text-secondary-emphasis border', icon: 'fa-pause' },
  Verificato: { label: 'Verificato', badge: 'bg-info-subtle text-info-emphasis border', icon: 'fa-check' },
  Normalizzazione: { label: 'Normalizzazione indirizzo', badge: 'bg-warning-subtle text-warning-emphasis border', icon: 'fa-map-pin' },
  Inviato: { label: 'Inviato a Poste', badge: 'bg-info-subtle text-info-emphasis border', icon: 'fa-truck' },
  Elaborato: { label: 'Elaborato', badge: 'bg-info-subtle text-info-emphasis border', icon: 'fa-gears' },
  AttesaStampa: { label: 'Attesa stampa', badge: 'bg-info-subtle text-info-emphasis border', icon: 'fa-print' },
  Confermato: { label: 'Confermato', badge: 'bg-primary-subtle text-primary-emphasis border', icon: 'fa-thumbs-up' },
  Rimandato: { label: 'Rimandato (ritento)', badge: 'bg-warning-subtle text-warning-emphasis border', icon: 'fa-rotate' },
  Consegnato: { label: 'Consegnato', badge: 'bg-success-subtle text-success-emphasis border', icon: 'fa-circle-check' },
  NonConsegnato: { label: 'Non consegnato', badge: 'bg-danger-subtle text-danger-emphasis border', icon: 'fa-circle-xmark' },
  ConsegnaParziale: { label: 'Consegna parziale', badge: 'bg-warning-subtle text-warning-emphasis border', icon: 'fa-triangle-exclamation' },
  Errore: { label: 'Errore', badge: 'bg-danger-subtle text-danger-emphasis border', icon: 'fa-circle-exclamation' },
  Eliminato: { label: 'Eliminato', badge: 'bg-light text-dark border', icon: 'fa-trash' },
};

function PostalStatusBadge({ status }: { status: string | null | undefined }): React.JSX.Element {
  if (!status) return <span className="badge bg-light text-dark border">In corso</span>;
  const meta = POSTAL_STATUS_META[status] ?? { label: status, badge: 'bg-light text-dark border', icon: 'fa-circle-question' };
  return <span className={`badge ${meta.badge}`}><i className={`fa-solid ${meta.icon} me-1`}></i>{meta.label}</span>;
}
```

- [ ] **Step 3: Aggiungi la colonna nella riga storico tentativi (stesso punto della colonna `SendStatusBadge status={a.sendStatus}`)**

Nella stessa riga di tabella dove compare `<SendStatusBadge status={a.sendStatus} />`
per il canale SEND, aggiungi un ramo condizionale analogo per POSTAL:

```tsx
                                        {a.channelType === 'POSTAL' && (
                                          <td className="small"><PostalStatusBadge status={a.postalStatus} /></td>
                                        )}
```

(Verifica se la cella è già dentro un `{a.channelType === 'SEND' && (...)}`
esistente — in tal caso aggiungi un ramo `else if`/condizione sorella dello
stesso pattern, non annidato dentro quello SEND.)

- [ ] **Step 4: Ripeti per la riga dettaglio destinatario (stesso punto di `r.sendStatus`)**

```tsx
                                          {r.channelType === 'POSTAL' && (
                                            <td className="small"><PostalStatusBadge status={r.postalStatus} /></td>
                                          )}
```

- [ ] **Step 5: Type-check frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 6: Verifica manuale nel browser**

Apri il dettaglio di una campagna POSTAL esistente (o quella creata in Task
9), verifica che la colonna stato consegna compaia (mostrerà "In corso"
finché `postalStatus` è null, coerente col fatto che nessun invio reale è
ancora stato fatto in questo ambiente di test).

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend): aggiungi badge stato consegna POSTAL/GlobalCom"
```

---

## Self-Review

**Copertura spec:**
- §1 invio reale + dedup retry-only + UserData1 → Task 3, 4, 5.
- §2 tracking consegna (`dettagli_documento`) → Task 6.
- §3 modello dati → Task 1.
- §4 multicanale App IO → Task 4 (Step 3, riga 138).
- §5 settings → Task 2, 8.
- §6 wizard → Task 9.
- §7 badge/dettaglio → Task 10.
- "Perché POSTAL resta BullMQ" → nessun task dedicato, è una non-azione
  (nessuna migrazione a pipeline a demoni), coerente con tutto il piano che
  lascia intatti coda/processor/UI Motori.

**Placeholder scan:** nessun TBD/TODO; i due punti in cui il piano dice
"adatta allo stile esistente" (Task 4 Step 2, Task 8/9 punti di
inserimento in `App.tsx`) sono per forza di cose non fissabili a priori —
`App.tsx` è un file di ~7000 righe che cambia release su release, non è
sicuro incollare un `old_string` letterale che potrebbe non matchare più al
momento dell'esecuzione. Il codice sostanziale (nuovi state, nuovo JSX,
nuovo branch di config) è comunque scritto per intero, non descritto a
parole.

**Coerenza tipi:** `GbcAddress`/`GbcCredentials`/`GbcDocStatus`/
`GbcInvioParams` definiti in Task 3, riusati identici in Task 5/6 senza
divergenze di nome campo. `ChannelSendResult` invariato. `attemptsMade?:
number` stesso nome/tipo in Task 4 (interfaccia+processor) e Task 5
(consumo in `PostalStrategy`).
