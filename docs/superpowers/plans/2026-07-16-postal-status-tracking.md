# Tracking avanzamento POSTAL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Barra impilata stato POSTAL (14 stati GBC) nel dettaglio campagna + 2 CSV dedicati (Attuale/Storico) con IDPRO, codice/descrizione errore, storico date per stato costruito da noi (GlobalCom non lo fornisce) ed esito App IO, al posto del report generico "download" (privo di senso per la posta cartacea).

**Architecture:** A differenza di SEND (dove PN restituisce uno storico stati completo), GlobalCom espone solo lo stato corrente (`dettagli_documento`). Lo storico va quindi costruito appendendo un elemento ogni volta che il poll rileva una transizione (già rilevata da `postal-status-sync.service.ts`, oggi scartata) — e il primissimo stato (`Accettato`) va scritto subito al momento dell'invio riuscito, in `notification.processor.ts` (unico punto con accesso ad `attemptRepo` dopo `strategy.send()`), non nella strategy stessa (che non tocca il DB). Backend espone un endpoint di aggregazione per la barra e due endpoint CSV, con lo stesso pattern già costruito per SEND. Frontend generalizza il componente `SendStatusBar` (task SEND) in `ChannelStatusBar` riutilizzabile, e aggiunge una sezione POSTAL analoga.

**Tech Stack:** NestJS 10 + TypeORM (backend), React 19 (frontend-admin), Jest per i test backend.

## Global Constraints

- Test backend SEMPRE con `--maxWorkers=2` (limite RAM WSL2 documentato in CLAUDE.md).
- Query TypeORM: MAI `leftJoinAndSelect` + `orderBy` + `take` sulla stessa query (bug noto TypeORM 0.3.30) — usare due query separate come già fa `getRecipientStats`/`getSendStatusBreakdown`.
- Date CSV formattate `it-IT` / `Europe/Rome`, campi CSV sempre passati da `escapeCsvField` (previene formula injection).
- Migration DB: mai `synchronize` in prod, va scritta a mano e registrata in `database.module.ts`.
- Nessuna modifica al meccanismo di stop-poll (`TERMINAL_STATUSES` in `postal-status-sync.service.ts:12`).
- `rilevatoIl` nello storico è il momento del NOSTRO poll (ogni 5 minuti), non l'istante esatto lato GlobalCom — limite intrinseco del provider, non altrimenti risolvibile.
- Per lo storico ("Storico" CSV), ogni colonna-stato registra la PRIMA occorrenza di quello stato (uno stato transitorio come `Rimandato` può ripresentarsi più volte sui retry GBC — si vuole "quando è stato raggiunto la prima volta", stessa semantica scelta per SEND).

---

## File Structure

- **Modifica** `apps/backend/src/entities/notification-attempt.entity.ts` — 1 nuova colonna jsonb (`postalStatusHistory`).
- **Crea** `apps/backend/src/database/migrations/1784600000000-AddPostalStatusHistoryColumn.ts` — migration.
- **Modifica** `apps/backend/src/database/database.module.ts` — registra la migration.
- **Modifica** `apps/backend/src/channels/postal/postal-status-sync.service.ts` — appende a `postalStatusHistory` ad ogni transizione rilevata.
- **Modifica** `apps/backend/src/queue/notification.processor.ts` — scrive subito il primo stato (`Accettato`) in `postalStatus`/`postalStatusHistory` al momento dell'invio POSTAL riuscito.
- **Crea** `apps/backend/src/campaigns/postal-status-labels.util.ts` — label italiane stato + elenco ordinato colonne storico (mirror di `POSTAL_STATUS_META` frontend, 14 stati).
- **Modifica** `apps/backend/src/campaigns/dto/campaign-stats.dto.ts` — nuovi DTO (`PostalStatusBreakdownDto`, `PostalReportRowDto`, `PostalReportDto`).
- **Crea** `apps/backend/src/campaigns/postal-report-csv.util.ts` — 2 CSV builder (attuale/storico).
- **Modifica** `apps/backend/src/campaigns/campaigns.service.ts` — `getPostalStatusBreakdown()` + `getPostalReportRows()`.
- **Modifica** `apps/backend/src/campaigns/campaigns.controller.ts` — 3 nuovi endpoint.
- **Modifica** `apps/frontend-admin/src/App.tsx` — generalizza `SendStatusBar` → `ChannelStatusBar`, aggiunge sezione barra POSTAL, fetch, 2 bottoni export POSTAL.

---

### Task 1: Migration + entity — colonna storico stato POSTAL

**Files:**
- Modify: `apps/backend/src/entities/notification-attempt.entity.ts:87-89`
- Create: `apps/backend/src/database/migrations/1784600000000-AddPostalStatusHistoryColumn.ts`
- Modify: `apps/backend/src/database/database.module.ts:30,44`

**Interfaces:**
- Produces: `NotificationAttempt.postalStatusHistory: Array<{ stato: string; rilevatoIl: string }> | null` — usato da Task 2, 3, 6.

- [ ] **Step 1: Aggiungi la colonna all'entity**

In `apps/backend/src/entities/notification-attempt.entity.ts`, subito dopo il campo `postalStatusUpdatedAt` (riga 88), aggiungi:

```typescript
  @Column({ type: 'jsonb', name: 'postal_status_history', nullable: true })
  postalStatusHistory!: Array<{ stato: string; rilevatoIl: string }> | null;
```

- [ ] **Step 2: Scrivi la migration**

Crea `apps/backend/src/database/migrations/1784600000000-AddPostalStatusHistoryColumn.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPostalStatusHistoryColumn1784600000000 implements MigrationInterface {
    name = 'AddPostalStatusHistoryColumn1784600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "postal_status_history" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "postal_status_history"`);
    }
}
```

- [ ] **Step 3: Registra la migration in `database.module.ts`**

Aggiungi l'import dopo la riga 30 (`AddSendStatusHistoryColumns1784500000000`):

```typescript
import { AddPostalStatusHistoryColumn1784600000000 } from './migrations/1784600000000-AddPostalStatusHistoryColumn';
```

E aggiungi `AddPostalStatusHistoryColumn1784600000000` in fondo all'array `migrations:` alla riga 44.

- [ ] **Step 4: Verifica tsc**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 5: Genera/verifica la migration su DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_test_postal;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_test_postal" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_test_postal;"
```

Expected: la migration `AddPostalStatusHistoryColumn1784600000000` esegue senza errori.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/entities/notification-attempt.entity.ts apps/backend/src/database/migrations/1784600000000-AddPostalStatusHistoryColumn.ts apps/backend/src/database/database.module.ts
git commit -m "feat(backend): aggiungi colonna storico stato POSTAL"
```

---

### Task 2: Sync POSTAL — appendi a storico su transizione

**Files:**
- Modify: `apps/backend/src/channels/postal/postal-status-sync.service.ts:50-61`
- Test: `apps/backend/src/channels/postal/postal-status-sync.service.spec.ts`

**Interfaces:**
- Consumes: `NotificationAttempt.postalStatusHistory` (Task 1).
- Produces: nessuna nuova interfaccia pubblica — comportamento interno del cron.

- [ ] **Step 1: Scrivi i test falliti**

In `apps/backend/src/channels/postal/postal-status-sync.service.spec.ts`, sostituisci il test `'aggiorna postalStatus quando lo stato è cambiato'` (righe 70-82) con:

```typescript
  it('aggiorna postalStatus e appende a postalStatusHistory quando lo stato è cambiato', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Accettato', postalStatusUpdatedAt: null, postalStatusHistory: [{ stato: 'Accettato', rilevatoIl: '2026-01-10T10:00:00.000Z' }] };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Consegnato' });

    await service.handleCron();

    expect(globalCom.dettagliDocumento).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: activeProvider.creds.baseUrl }),
      'IDPRO1',
    );
    expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'a1',
      postalStatus: 'Consegnato',
      postalStatusHistory: [
        { stato: 'Accettato', rilevatoIl: '2026-01-10T10:00:00.000Z' },
        { stato: 'Consegnato', rilevatoIl: expect.any(String) },
      ],
    }));
  });

  it('non duplica un elemento in postalStatusHistory se lo stato non è cambiato', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Inviato', postalStatusUpdatedAt: null, postalStatusHistory: [{ stato: 'Inviato', rilevatoIl: '2026-01-10T10:00:00.000Z' }] };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Inviato' });

    await service.handleCron();

    expect(attemptRepo.save).not.toHaveBeenCalled();
    expect(attempt.postalStatusHistory).toEqual([{ stato: 'Inviato', rilevatoIl: '2026-01-10T10:00:00.000Z' }]);
  });

  it('gestisce postalStatusHistory assente (null) su un attempt esistente senza storico pregresso', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Inviato', postalStatusUpdatedAt: null, postalStatusHistory: null };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Consegnato' });

    await service.handleCron();

    expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'a1',
      postalStatusHistory: [{ stato: 'Consegnato', rilevatoIl: expect.any(String) }],
    }));
  });
```

- [ ] **Step 2: Esegui i test, verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest postal-status-sync.service --maxWorkers=2`
Expected: FAIL su `postalStatusHistory` non popolato (il service non lo scrive ancora).

- [ ] **Step 3: Implementa la modifica al service**

In `apps/backend/src/channels/postal/postal-status-sync.service.ts`, sostituisci il blocco del ciclo `for` (righe 50-61) con:

```typescript
    for (const attempt of attempts) {
      try {
        const stato = await this.globalCom.dettagliDocumento(creds, attempt.postalTrackingId!);
        if (stato && stato.stato !== attempt.postalStatus) {
          attempt.postalStatus = stato.stato;
          attempt.postalStatusUpdatedAt = new Date();
          attempt.postalStatusHistory = [
            ...(attempt.postalStatusHistory ?? []),
            { stato: stato.stato, rilevatoIl: new Date().toISOString() },
          ];
          await this.attemptRepo.save(attempt);
        }
      } catch (err: any) {
        this.logger.warn(`Errore aggiornamento stato POSTAL per attempt ${attempt.id} (IDPRO=${attempt.postalTrackingId}): ${err.message}`);
      }
    }
```

- [ ] **Step 4: Esegui i test, verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest postal-status-sync.service --maxWorkers=2`
Expected: PASS (tutti i test, inclusi i 3 nuovi)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/channels/postal/postal-status-sync.service.ts apps/backend/src/channels/postal/postal-status-sync.service.spec.ts
git commit -m "feat(backend): appendi a postalStatusHistory su ogni transizione rilevata"
```

---

### Task 3: Scrivi il primo stato (Accettato) al momento dell'invio

**Files:**
- Modify: `apps/backend/src/queue/notification.processor.ts:210-215`
- Test: `apps/backend/src/queue/notification.processor.spec.ts:295-323`

**Interfaces:**
- Consumes: `NotificationAttempt.postalStatusHistory` (Task 1); `primaryResult.responsePayload.stato` (già prodotto da `postal.strategy.ts:128`, non modificato da questo task).
- Produces: nessuna nuova interfaccia pubblica.

- [ ] **Step 1: Scrivi i test falliti**

In `apps/backend/src/queue/notification.processor.spec.ts`, nel blocco `describe('POSTAL: persistenza postalTrackingId e piggyback attemptNumber', ...)` (riga 295), aggiungi questo test subito dopo `'scrive postalTrackingId sulla colonna dedicata subito dopo un invio POSTAL riuscito'` (dopo la riga 308):

```typescript
    it('scrive subito postalStatus="Accettato" e il primo elemento di postalStatusHistory dopo un invio POSTAL riuscito', async () => {
      await processor.process(mockJob(postalData));

      expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', expect.objectContaining({
        postalStatus: 'Accettato',
        postalStatusHistory: [{ stato: 'Accettato', rilevatoIl: expect.any(String) }],
      }));
    });

    it('usa lo stato reale da responsePayload.stato invece di un valore fisso "Accettato"', async () => {
      mockPostalStrategy.send.mockResolvedValue({ messageId: 'IDPRO123', responsePayload: { stato: 'Sospeso', idPro: 'IDPRO123' } });

      await processor.process(mockJob(postalData));

      expect(mockAttemptRepo.update).toHaveBeenCalledWith('att-1', expect.objectContaining({
        postalStatus: 'Sospeso',
        postalStatusHistory: [{ stato: 'Sospeso', rilevatoIl: expect.any(String) }],
      }));
    });
```

- [ ] **Step 2: Esegui i test, verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest notification.processor --maxWorkers=2 -t "POSTAL"`
Expected: FAIL — `mockAttemptRepo.update` non è mai chiamato con `postalStatus`/`postalStatusHistory`.

- [ ] **Step 3: Implementa la modifica al processor**

In `apps/backend/src/queue/notification.processor.ts`, sostituisci il blocco (righe 210-215):

```typescript
      if (primaryResult) {
        await this.attemptRepo.update(attemptId, { responsePayload });
        if (channel === 'POSTAL' && primaryResult.messageId) {
          await this.attemptRepo.update(attemptId, { postalTrackingId: primaryResult.messageId });
        }
      }
```

con:

```typescript
      if (primaryResult) {
        await this.attemptRepo.update(attemptId, { responsePayload });
        if (channel === 'POSTAL' && primaryResult.messageId) {
          const statoIniziale = (primaryResult.responsePayload as Record<string, unknown> | undefined)?.['stato'] as string | undefined;
          await this.attemptRepo.update(attemptId, {
            postalTrackingId: primaryResult.messageId,
            ...(statoIniziale ? {
              postalStatus: statoIniziale,
              postalStatusHistory: [{ stato: statoIniziale, rilevatoIl: new Date().toISOString() }],
            } : {}),
          });
        }
      }
```

- [ ] **Step 4: Esegui i test, verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest notification.processor --maxWorkers=2`
Expected: PASS (tutti i test del file, inclusi i 2 nuovi)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/queue/notification.processor.ts apps/backend/src/queue/notification.processor.spec.ts
git commit -m "feat(backend): scrivi subito il primo stato POSTAL al momento dell'invio"
```

---

### Task 4: Label italiane stato POSTAL + colonne storico

**Files:**
- Create: `apps/backend/src/campaigns/postal-status-labels.util.ts`
- Test: `apps/backend/src/campaigns/postal-status-labels.util.spec.ts`

**Interfaces:**
- Produces: `postalStatusLabel(status: string | null): string`, `POSTAL_STATUS_HISTORY_COLUMNS: Array<{ status: string; header: string }>` — usati da Task 7 (CSV builder).

- [ ] **Step 1: Scrivi i test falliti**

Crea `apps/backend/src/campaigns/postal-status-labels.util.spec.ts`:

```typescript
import { postalStatusLabel, POSTAL_STATUS_HISTORY_COLUMNS } from './postal-status-labels.util';

describe('postalStatusLabel', () => {
  it('traduce uno stato GBC noto', () => {
    expect(postalStatusLabel('Consegnato')).toBe('Consegnato');
    expect(postalStatusLabel('NonConsegnato')).toBe('Non consegnato');
  });
  it('ritorna "In corso" per null', () => {
    expect(postalStatusLabel(null)).toBe('In corso');
  });
  it('ritorna il valore grezzo per uno stato non mappato', () => {
    expect(postalStatusLabel('NUOVO_STATO_MAI_VISTO')).toBe('NUOVO_STATO_MAI_VISTO');
  });
});

describe('POSTAL_STATUS_HISTORY_COLUMNS', () => {
  it('contiene 14 colonne, una per ciascuno stato GBC', () => {
    expect(POSTAL_STATUS_HISTORY_COLUMNS).toHaveLength(14);
    expect(POSTAL_STATUS_HISTORY_COLUMNS.map((c) => c.status)).toEqual([
      'Accettato', 'Sospeso', 'Verificato', 'Normalizzazione', 'Inviato', 'Elaborato',
      'AttesaStampa', 'Confermato', 'Rimandato', 'Consegnato', 'NonConsegnato',
      'ConsegnaParziale', 'Errore', 'Eliminato',
    ]);
  });
});
```

- [ ] **Step 2: Esegui i test, verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest postal-status-labels --maxWorkers=2`
Expected: FAIL con "Cannot find module './postal-status-labels.util'"

- [ ] **Step 3: Implementa**

Crea `apps/backend/src/campaigns/postal-status-labels.util.ts`:

```typescript
/**
 * Mirror backend delle label italiane già in POSTAL_STATUS_META
 * (apps/frontend-admin/src/App.tsx) — stesse 14 chiavi dell'enum GBCStatus.
 */
const POSTAL_STATUS_LABELS: Record<string, string> = {
  Accettato: 'Accettato',
  Sospeso: 'Sospeso',
  Verificato: 'Verificato',
  Normalizzazione: 'Normalizzazione indirizzo',
  Inviato: 'Inviato a Poste',
  Elaborato: 'Elaborato',
  AttesaStampa: 'Attesa stampa',
  Confermato: 'Confermato',
  Rimandato: 'Rimandato (ritento)',
  Consegnato: 'Consegnato',
  NonConsegnato: 'Non consegnato',
  ConsegnaParziale: 'Consegna parziale',
  Errore: 'Errore',
  Eliminato: 'Eliminato',
};

export function postalStatusLabel(status: string | null): string {
  if (!status) return 'In corso';
  return POSTAL_STATUS_LABELS[status] ?? status;
}

/** Ordine e intestazioni delle colonne data per il CSV "Storico" (14 stati GBC). */
export const POSTAL_STATUS_HISTORY_COLUMNS: Array<{ status: string; header: string }> = [
  { status: 'Accettato', header: 'Data Accettato' },
  { status: 'Sospeso', header: 'Data Sospeso' },
  { status: 'Verificato', header: 'Data Verificato' },
  { status: 'Normalizzazione', header: 'Data Normalizzazione' },
  { status: 'Inviato', header: 'Data Inviato' },
  { status: 'Elaborato', header: 'Data Elaborato' },
  { status: 'AttesaStampa', header: 'Data Attesa Stampa' },
  { status: 'Confermato', header: 'Data Confermato' },
  { status: 'Rimandato', header: 'Data Rimandato' },
  { status: 'Consegnato', header: 'Data Consegnato' },
  { status: 'NonConsegnato', header: 'Data Non Consegnato' },
  { status: 'ConsegnaParziale', header: 'Data Consegna Parziale' },
  { status: 'Errore', header: 'Data Errore' },
  { status: 'Eliminato', header: 'Data Eliminato' },
];
```

- [ ] **Step 4: Esegui i test, verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest postal-status-labels --maxWorkers=2`
Expected: PASS (5 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/campaigns/postal-status-labels.util.ts apps/backend/src/campaigns/postal-status-labels.util.spec.ts
git commit -m "feat(backend): label italiane stato POSTAL"
```

---

### Task 5: DTO backend per breakdown e report POSTAL

**Files:**
- Modify: `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`

**Interfaces:**
- Produces: `PostalStatusBreakdownDto`, `PostalReportRowDto`, `PostalReportDto` — usati da Task 6 (service) e Task 7 (CSV builder).

- [ ] **Step 1: Aggiungi i nuovi DTO**

In `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`, aggiungi in fondo al file (dopo `SendReportDto`):

```typescript

export interface PostalStatusBreakdownDto {
  /** null = attempt non ancora sincronizzato ("In corso"). */
  status: string | null;
  count: number;
}

export interface PostalReportRowDto {
  codiceFiscale: string;
  fullName: string | null;
  postalTrackingId: string | null;
  postalStatus: string | null;
  postalStatusHistory: Array<{ stato: string; rilevatoIl: string }>;
  codiceErrore: string | null;
  descrizioneErrore: string | null;
  /** null se la campagna non ha co-consegna App IO configurata. */
  appIoOutcome: { success: boolean; error: string | null } | null;
}

export interface PostalReportDto {
  /** Determina se i CSV builder devono includere la colonna "Esito App IO". */
  hasAppIoCoDelivery: boolean;
  rows: PostalReportRowDto[];
}
```

- [ ] **Step 2: Verifica tsc**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/campaigns/dto/campaign-stats.dto.ts
git commit -m "feat(backend): DTO breakdown stato POSTAL e report CSV"
```

---

### Task 6: Service — breakdown e righe report POSTAL

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `PostalStatusBreakdownDto`, `PostalReportDto`, `PostalReportRowDto` (Task 5); `resolveSecondaryAppIoConfig` (già importato in `campaigns.service.ts:25`); `NotificationAttempt.postalStatusHistory` (Task 1).
- Produces: `CampaignsService.getPostalStatusBreakdown(campaignId: string): Promise<PostalStatusBreakdownDto[]>`, `CampaignsService.getPostalReportRows(campaignId: string): Promise<PostalReportDto>` — usati da Task 8 (controller).

Nota implementativa: `codiceErrore`/`descrizioneErrore` nel report vengono letti da `attempt.responsePayload` dell'ultimo attempt (`responsePayload` è il payload grezzo dell'ultima risposta GlobalCom, scritto da `notification.processor.ts`; i campi possibili sono `codiceErrore`/`descrizione` come restituiti da `GbcDocStatus`, vedi `globalcom-client.service.ts:42-46` — leggerli con fallback `null` se assenti).

- [ ] **Step 1: Guarda il pattern gemello già esistente**

Apri `apps/backend/src/campaigns/campaigns.service.ts` e rileggi `getSendStatusBreakdown`/`getSendReportRows` (subito dopo `getDownloadReportRows`, circa riga 1069-1164) — questo task ne è il mirror per POSTAL, stessa struttura a due query.

- [ ] **Step 2: Scrivi i test falliti**

Aggiungi in fondo a `apps/backend/src/campaigns/campaigns.service.spec.ts` (stesso stile/convenzione di mock già usato per i test `getSendStatusBreakdown`/`getSendReportRows` esistenti nello stesso file — usa `buildModule()` e i mock `campaignRepoMock`/`recipientRepoMock`/`attemptRepoMock` se quella è la convenzione reale nel file, altrimenti quella usata dal resto del file):

```typescript
  describe('getPostalStatusBreakdown', () => {
    it('conta i destinatari per ultimo postalStatus rilevato, un solo conteggio per destinatario', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL' });
      recipientRepoMock.find.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
      attemptRepoMock.find.mockResolvedValue([
        { recipientId: 'r1', attemptNumber: 1, postalStatus: 'Accettato' },
        { recipientId: 'r1', attemptNumber: 2, postalStatus: 'Consegnato' },
        { recipientId: 'r2', attemptNumber: 1, postalStatus: 'Consegnato' },
      ]);

      const result = await service.getPostalStatusBreakdown('c1');

      expect(result).toEqual(expect.arrayContaining([{ status: 'Consegnato', count: 2 }]));
      expect(result).toHaveLength(1);
    });

    it('lancia NotFoundException se la campagna non esiste', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue(null);
      await expect(service.getPostalStatusBreakdown('missing')).rejects.toThrow('Campaign missing not found');
    });
  });

  describe('getPostalReportRows', () => {
    it('proietta IDPRO, storico ed errore dall\'ultimo attempt per destinatario', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL', channelConfig: {} });
      recipientRepoMock.find.mockResolvedValue([{ id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'Mario Rossi' }]);
      attemptRepoMock.find.mockResolvedValue([
        {
          recipientId: 'r1', attemptNumber: 1, postalTrackingId: 'IDPRO1', postalStatus: 'Consegnato',
          postalStatusHistory: [{ stato: 'Accettato', rilevatoIl: '2026-01-10T10:00:00.000Z' }],
          responsePayload: { codiceErrore: '', descrizione: '' },
        },
      ]);

      const result = await service.getPostalReportRows('c1');

      expect(result.hasAppIoCoDelivery).toBe(false);
      expect(result.rows).toEqual([{
        codiceFiscale: 'RSSMRA80A01H501U',
        fullName: 'Mario Rossi',
        postalTrackingId: 'IDPRO1',
        postalStatus: 'Consegnato',
        postalStatusHistory: [{ stato: 'Accettato', rilevatoIl: '2026-01-10T10:00:00.000Z' }],
        codiceErrore: '',
        descrizioneErrore: '',
        appIoOutcome: null,
      }]);
    });

    it('include appIoOutcome solo se la campagna ha co-consegna App IO configurata', async () => {
      campaignRepoMock.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL', channelConfig: { secondaryChannels: [{ channel: 'APP_IO', mode: 'parallel' }] } });
      recipientRepoMock.find.mockResolvedValue([{ id: 'r1', codiceFiscale: 'RSSMRA80A01H501U', fullName: 'Mario Rossi' }]);
      attemptRepoMock.find.mockResolvedValue([
        {
          recipientId: 'r1', attemptNumber: 1, postalTrackingId: 'IDPRO1', postalStatus: 'Consegnato',
          postalStatusHistory: [], responsePayload: { appIo: { success: true } },
        },
      ]);

      const result = await service.getPostalReportRows('c1');

      expect(result.hasAppIoCoDelivery).toBe(true);
      expect(result.rows[0].appIoOutcome).toEqual({ success: true, error: null });
    });
  });
```

- [ ] **Step 3: Esegui i test, verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: FAIL con "service.getPostalStatusBreakdown is not a function"

- [ ] **Step 4: Implementa i due metodi**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiungi subito dopo `getSendReportRows` (dopo la riga 1164, prima di `assertDraftForAttachments`):

```typescript
  async getPostalStatusBreakdown(campaignId: string): Promise<PostalStatusBreakdownDto[]> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipientIds = (await this.recipientRepo.find({ where: { campaignId }, select: ['id'] })).map((r) => r.id);
    if (recipientIds.length === 0) return [];

    const attempts = await this.attemptRepo.find({
      where: { recipientId: In(recipientIds), channelType: 'POSTAL' },
      select: ['recipientId', 'attemptNumber', 'postalStatus'],
    });

    const latestByRecipient = new Map<string, NotificationAttempt>();
    for (const a of attempts) {
      const current = latestByRecipient.get(a.recipientId);
      if (!current || a.attemptNumber > current.attemptNumber) latestByRecipient.set(a.recipientId, a);
    }

    const counts = new Map<string | null, number>();
    for (const a of latestByRecipient.values()) {
      counts.set(a.postalStatus, (counts.get(a.postalStatus) ?? 0) + 1);
    }

    return Array.from(counts.entries()).map(([status, count]) => ({ status, count }));
  }

  async getPostalReportRows(campaignId: string): Promise<PostalReportDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipients = await this.recipientRepo.find({
      where: { campaignId },
      select: ['id', 'codiceFiscale', 'fullName'],
      order: { createdAt: 'ASC' },
    });
    if (recipients.length === 0) return { hasAppIoCoDelivery: false, rows: [] };

    const recipientIds = recipients.map((r) => r.id);
    const attempts = await this.attemptRepo.find({
      where: { recipientId: In(recipientIds), channelType: 'POSTAL' },
    });

    const latestByRecipient = new Map<string, NotificationAttempt>();
    const firstByRecipient = new Map<string, NotificationAttempt>();
    for (const a of attempts) {
      const current = latestByRecipient.get(a.recipientId);
      if (!current || a.attemptNumber > current.attemptNumber) latestByRecipient.set(a.recipientId, a);
      // Segnale App IO esiste solo sul primo tentativo (mai ritentato),
      // stesso vincolo già documentato in getChannelBreakdown()/getSendReportRows().
      if (a.attemptNumber === 1) firstByRecipient.set(a.recipientId, a);
    }

    const hasAppIoCoDelivery = !!resolveSecondaryAppIoConfig(campaign.channelConfig);

    const rows: PostalReportRowDto[] = recipients.map((r) => {
      const latest = latestByRecipient.get(r.id);
      const first = firstByRecipient.get(r.id);
      const appIo = hasAppIoCoDelivery
        ? ((first?.responsePayload as Record<string, unknown> | undefined)?.['appIo'] as { success?: boolean; error?: string } | undefined)
        : undefined;
      const latestPayload = latest?.responsePayload as Record<string, unknown> | undefined;

      return {
        codiceFiscale: r.codiceFiscale,
        fullName: r.fullName,
        postalTrackingId: latest?.postalTrackingId ?? null,
        postalStatus: latest?.postalStatus ?? null,
        postalStatusHistory: latest?.postalStatusHistory ?? [],
        codiceErrore: (latestPayload?.['codiceErrore'] as string | undefined) ?? null,
        descrizioneErrore: (latestPayload?.['descrizione'] as string | undefined) ?? null,
        appIoOutcome: appIo ? { success: !!appIo.success, error: appIo.error ?? null } : null,
      };
    });

    return { hasAppIoCoDelivery, rows };
  }
```

Aggiungi l'import dei nuovi DTO nella riga che già importa `SendReportRowDto` da `./dto/campaign-stats.dto` (estendi l'elenco con `PostalStatusBreakdownDto, PostalReportDto, PostalReportRowDto`, non aggiungere una seconda riga di import).

- [ ] **Step 5: Esegui i test, verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: PASS (4 nuovi test + tutti i preesistenti)

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): getPostalStatusBreakdown e getPostalReportRows"
```

---

### Task 7: CSV builder POSTAL (Attuale/Storico)

**Files:**
- Create: `apps/backend/src/campaigns/postal-report-csv.util.ts`
- Test: `apps/backend/src/campaigns/postal-report-csv.util.spec.ts`

**Interfaces:**
- Consumes: `PostalReportDto`, `PostalReportRowDto` (Task 5); `postalStatusLabel`, `POSTAL_STATUS_HISTORY_COLUMNS` (Task 4); `escapeCsvField` (`apps/backend/src/campaigns/csv.util.ts:6`).
- Produces: `buildPostalReportAttualeCsv(report: PostalReportDto): string`, `buildPostalReportStoricoCsv(report: PostalReportDto): string` — usati da Task 8 (controller).

Nota importante (diversa da SEND): nel CSV "Storico" ogni colonna-stato deve riportare la PRIMA occorrenza di quello stato in `postalStatusHistory` (uno stato come `Rimandato` può ripetersi più volte) — costruire la mappa stato→data scorrendo l'array in ordine e scrivendo SOLO se la chiave non è già presente (`if (!map.has(h.stato)) map.set(h.stato, h.rilevatoIl)`), non l'ultima come nel CSV "Attuale" di SEND.

- [ ] **Step 1: Scrivi i test falliti**

Crea `apps/backend/src/campaigns/postal-report-csv.util.spec.ts`:

```typescript
import { buildPostalReportAttualeCsv, buildPostalReportStoricoCsv } from './postal-report-csv.util';
import type { PostalReportDto } from './dto/campaign-stats.dto';

const baseReport: PostalReportDto = {
  hasAppIoCoDelivery: false,
  rows: [{
    codiceFiscale: 'RSSMRA80A01H501U',
    fullName: 'Mario Rossi',
    postalTrackingId: 'IDPRO1',
    postalStatus: 'Consegnato',
    postalStatusHistory: [
      { stato: 'Accettato', rilevatoIl: '2026-01-10T10:00:00Z' },
      { stato: 'Inviato', rilevatoIl: '2026-01-11T10:00:00Z' },
      { stato: 'Rimandato', rilevatoIl: '2026-01-12T10:00:00Z' },
      { stato: 'Rimandato', rilevatoIl: '2026-01-13T10:00:00Z' },
      { stato: 'Consegnato', rilevatoIl: '2026-01-14T09:00:00Z' },
    ],
    codiceErrore: null,
    descrizioneErrore: null,
    appIoOutcome: null,
  }],
};

describe('buildPostalReportAttualeCsv', () => {
  it('include intestazioni e riga con stato/data correnti (ultimo elemento storico)', () => {
    const csv = buildPostalReportAttualeCsv(baseReport);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('"Codice Fiscale";"Nominativo";"IDPRO";"Stato";"Data Stato";"Codice Errore";"Descrizione Errore"');
    expect(lines[1]).toContain('"Consegnato"');
    expect(lines[1]).not.toContain('Esito App IO');
  });

  it('aggiunge la colonna Esito App IO solo se hasAppIoCoDelivery', () => {
    const report: PostalReportDto = {
      hasAppIoCoDelivery: true,
      rows: [{ ...baseReport.rows[0], appIoOutcome: { success: true, error: null } }],
    };
    const csv = buildPostalReportAttualeCsv(report);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('"Esito App IO"');
    expect(lines[1]).toContain('"Consegnato"');
  });
});

describe('buildPostalReportStoricoCsv', () => {
  it('include una colonna data per ciascuno dei 14 stati, vuota se mai raggiunto', () => {
    const csv = buildPostalReportStoricoCsv(baseReport);
    const lines = csv.split('\n');
    expect(lines[0].split(';')).toHaveLength(5 + 14);
    const headers = lines[0].split(';');
    const sospesoIndex = headers.findIndex((h) => h === '"Data Sospeso"');
    expect(lines[1].split(';')[sospesoIndex]).toBe('""');
  });

  it('per uno stato ripetuto (Rimandato) registra la PRIMA occorrenza, non l\'ultima', () => {
    const csv = buildPostalReportStoricoCsv(baseReport);
    const lines = csv.split('\n');
    const headers = lines[0].split(';');
    const rimandatoIndex = headers.findIndex((h) => h === '"Data Rimandato"');
    const cell = lines[1].split(';')[rimandatoIndex];
    expect(cell).toContain(new Date('2026-01-12T10:00:00Z').toLocaleString('it-IT', { timeZone: 'Europe/Rome' }).split(',')[0]);
  });
});
```

- [ ] **Step 2: Esegui i test, verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest postal-report-csv --maxWorkers=2`
Expected: FAIL con "Cannot find module './postal-report-csv.util'"

- [ ] **Step 3: Implementa**

Crea `apps/backend/src/campaigns/postal-report-csv.util.ts`:

```typescript
import { escapeCsvField } from './csv.util';
import type { PostalReportDto, PostalReportRowDto } from './dto/campaign-stats.dto';
import { postalStatusLabel, POSTAL_STATUS_HISTORY_COLUMNS } from './postal-status-labels.util';

function formatDate(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleString('it-IT', { timeZone: 'Europe/Rome' }) : '';
}

function appIoOutcomeLabel(outcome: PostalReportRowDto['appIoOutcome']): string {
  if (!outcome) return '';
  return outcome.success ? 'Consegnato' : `Fallito: ${outcome.error ?? ''}`;
}

export function buildPostalReportAttualeCsv(report: PostalReportDto): string {
  const headers = ['Codice Fiscale', 'Nominativo', 'IDPRO', 'Stato', 'Data Stato', 'Codice Errore', 'Descrizione Errore'];
  if (report.hasAppIoCoDelivery) headers.push('Esito App IO');

  const lines = report.rows.map((r) => {
    // postalStatusHistory è append-only in ordine cronologico: l'ultimo
    // elemento è lo stato corrente.
    const latestEntry = r.postalStatusHistory[r.postalStatusHistory.length - 1];
    const fields = [
      r.codiceFiscale,
      r.fullName ?? '',
      r.postalTrackingId ?? '',
      postalStatusLabel(r.postalStatus),
      formatDate(latestEntry?.rilevatoIl),
      r.codiceErrore ?? '',
      r.descrizioneErrore ?? '',
    ];
    if (report.hasAppIoCoDelivery) fields.push(appIoOutcomeLabel(r.appIoOutcome));
    return fields.map(escapeCsvField).join(';');
  });

  return [headers.map(escapeCsvField).join(';'), ...lines].join('\n');
}

export function buildPostalReportStoricoCsv(report: PostalReportDto): string {
  const headers = [
    'Codice Fiscale', 'Nominativo', 'IDPRO', 'Codice Errore', 'Descrizione Errore',
    ...POSTAL_STATUS_HISTORY_COLUMNS.map((c) => c.header),
  ];
  if (report.hasAppIoCoDelivery) headers.push('Esito App IO');

  const lines = report.rows.map((r) => {
    // Prima occorrenza per stato (uno stato transitorio come "Rimandato" può
    // ripetersi più volte sui retry GBC): si registra solo la prima volta.
    const firstOccurrenceByStatus = new Map<string, string>();
    for (const h of r.postalStatusHistory) {
      if (!firstOccurrenceByStatus.has(h.stato)) firstOccurrenceByStatus.set(h.stato, h.rilevatoIl);
    }
    const fields = [
      r.codiceFiscale,
      r.fullName ?? '',
      r.postalTrackingId ?? '',
      r.codiceErrore ?? '',
      r.descrizioneErrore ?? '',
      ...POSTAL_STATUS_HISTORY_COLUMNS.map((c) => formatDate(firstOccurrenceByStatus.get(c.status))),
    ];
    if (report.hasAppIoCoDelivery) fields.push(appIoOutcomeLabel(r.appIoOutcome));
    return fields.map(escapeCsvField).join(';');
  });

  return [headers.map(escapeCsvField).join(';'), ...lines].join('\n');
}
```

- [ ] **Step 4: Esegui i test, verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest postal-report-csv --maxWorkers=2`
Expected: PASS (4 test)

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/campaigns/postal-report-csv.util.ts apps/backend/src/campaigns/postal-report-csv.util.spec.ts
git commit -m "feat(backend): CSV builder report POSTAL attuale/storico"
```

---

### Task 8: Endpoint controller POSTAL

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Test: `apps/backend/src/campaigns/campaigns.controller.spec.ts`

**Interfaces:**
- Consumes: `CampaignsService.getPostalStatusBreakdown`, `CampaignsService.getPostalReportRows` (Task 6); `buildPostalReportAttualeCsv`, `buildPostalReportStoricoCsv` (Task 7).
- Produces: `GET admin/campaigns/:id/postal-status-breakdown`, `GET admin/campaigns/:id/export-postal-report-attuale.csv`, `GET admin/campaigns/:id/export-postal-report-storico.csv` — usati da Task 9/10 (frontend).

- [ ] **Step 1: Guarda il pattern gemello già esistente**

In `apps/backend/src/campaigns/campaigns.controller.ts`, rileggi i 3 endpoint SEND (righe 547-566: `getSendStatusBreakdown`, `exportSendReportAttuale`, `exportSendReportStorico`) — questo task ne è il mirror per POSTAL.

- [ ] **Step 2: Scrivi i test falliti**

Aggiungi in fondo a `apps/backend/src/campaigns/campaigns.controller.spec.ts` (adatta i nomi delle variabili mock a quelli già usati nel file, stesso stile dei test `send status endpoints` già presenti):

```typescript
  describe('postal status endpoints', () => {
    it('getPostalStatusBreakdown delega al service', async () => {
      campaignsService.getPostalStatusBreakdown = jest.fn().mockResolvedValue([{ status: 'Consegnato', count: 3 }]);
      const result = await controller.getPostalStatusBreakdown('c1');
      expect(campaignsService.getPostalStatusBreakdown).toHaveBeenCalledWith('c1');
      expect(result).toEqual([{ status: 'Consegnato', count: 3 }]);
    });

    it('exportPostalReportAttuale scrive CSV con header e content-disposition corretti', async () => {
      campaignsService.getPostalReportRows = jest.fn().mockResolvedValue({ hasAppIoCoDelivery: false, rows: [] });
      const res: any = { setHeader: jest.fn(), send: jest.fn() };
      await controller.exportPostalReportAttuale('c1', res);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
      expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('report_postal_attuale_campagna_c1'));
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Codice Fiscale'));
    });

    it('exportPostalReportStorico scrive CSV con header e content-disposition corretti', async () => {
      campaignsService.getPostalReportRows = jest.fn().mockResolvedValue({ hasAppIoCoDelivery: false, rows: [] });
      const res: any = { setHeader: jest.fn(), send: jest.fn() };
      await controller.exportPostalReportStorico('c1', res);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('report_postal_storico_campagna_c1'));
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining('Data Accettato'));
    });
  });
```

- [ ] **Step 3: Esegui i test, verifica che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.controller --maxWorkers=2`
Expected: FAIL con "controller.getPostalStatusBreakdown is not a function"

- [ ] **Step 4: Implementa i 3 endpoint**

In `apps/backend/src/campaigns/campaigns.controller.ts`, aggiungi l'import subito dopo quello di `send-report-csv.util`:

```typescript
import { buildPostalReportAttualeCsv, buildPostalReportStoricoCsv } from './postal-report-csv.util';
```

Aggiungi i 3 endpoint subito dopo `exportSendReportStorico` (dopo la riga 566, prima di `@Delete(':id')`):

```typescript
  @Get(':id/postal-status-breakdown')
  getPostalStatusBreakdown(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getPostalStatusBreakdown(id);
  }

  @Get(':id/export-postal-report-attuale.csv')
  async exportPostalReportAttuale(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const report = await this.campaignsService.getPostalReportRows(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report_postal_attuale_campagna_${id.slice(0, 8)}.csv"`);
    res.send(buildPostalReportAttualeCsv(report));
  }

  @Get(':id/export-postal-report-storico.csv')
  async exportPostalReportStorico(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const report = await this.campaignsService.getPostalReportRows(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report_postal_storico_campagna_${id.slice(0, 8)}.csv"`);
    res.send(buildPostalReportStoricoCsv(report));
  }
```

- [ ] **Step 5: Esegui i test, verifica che passino**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.controller --maxWorkers=2`
Expected: PASS

- [ ] **Step 6: Esegui l'intera suite backend (nessuna regressione)**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: PASS, stesso failure-set di prima (baseline nota: 1 fallimento pre-esistente non correlato in `app.controller.spec.ts`, LDAP_HOST=mock — verificare con `git stash` se in dubbio).

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/campaigns.controller.spec.ts
git commit -m "feat(backend): endpoint breakdown stato POSTAL e export CSV attuale/storico"
```

---

### Task 9: Frontend — generalizza barra in ChannelStatusBar, sezione POSTAL

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:89-124` (generalizza componente), `:973` (nuovo state), `:3596-3651` (fetch/reset), `:7938-7952` (JSX SEND aggiornata), area dettaglio campagna POSTAL (nuova sezione)

**Interfaces:**
- Consumes: `POSTAL_STATUS_META` (`App.tsx:128-141`), endpoint `GET /campaigns/:id/postal-status-breakdown` (Task 8).
- Produces: componente `ChannelStatusBar` (generalizzazione di `SendStatusBar`) — usato sia per SEND sia per POSTAL.

- [ ] **Step 1: Riavvia il backend per applicare le modifiche dei task precedenti**

Run: `docker compose restart backend`

Verifica: `docker compose exec backend ls -la dist/campaigns/campaigns.controller.js dist/channels/postal/postal-status-sync.service.js dist/queue/notification.processor.js`
Expected: timestamp recente.

- [ ] **Step 2: Generalizza `SendStatusBar` in `ChannelStatusBar`**

In `apps/frontend-admin/src/App.tsx`, sostituisci il componente `SendStatusBar` (righe 89-124) con:

```typescript
type StatusMeta = { label: string; badge: string; icon: string };

function ChannelStatusBar({ breakdown, meta, pendingLabel }: { breakdown: Array<{ status: string | null; count: number }>; meta: Record<string, StatusMeta>; pendingLabel: string }): React.JSX.Element {
  const total = breakdown.reduce((sum, b) => sum + b.count, 0);
  if (total === 0) {
    return <div className="text-muted small">Nessun destinatario ancora processato.</div>;
  }
  return (
    <div>
      <div className="d-flex rounded overflow-hidden" style={{ height: '20px' }}>
        {breakdown.map((b) => {
          const m = b.status ? meta[b.status] : null;
          const pct = (b.count / total) * 100;
          const bgClass = (m ? m.badge.split(' ')[0] : 'bg-secondary');
          return (
            <div
              key={b.status ?? 'pending'}
              className={bgClass}
              style={{ width: `${pct}%` }}
              title={`${m ? m.label : pendingLabel}: ${b.count} (${pct.toFixed(0)}%)`}
            ></div>
          );
        })}
      </div>
      <div className="d-flex flex-wrap gap-2 mt-2 small">
        {breakdown.map((b) => {
          const m = b.status ? meta[b.status] : null;
          return (
            <span key={b.status ?? 'pending'} className="text-muted">
              <i className={`fas ${m ? m.icon : 'fa-hourglass-half'} me-1`}></i>
              {m ? m.label : pendingLabel}: <strong>{b.count}</strong>
            </span>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Aggiorna l'unico punto d'uso esistente (SEND)**

Cerca `<SendStatusBar breakdown={sendStatusBreakdown} />` (circa riga 7943) e sostituiscilo con:

```typescript
                            <ChannelStatusBar breakdown={sendStatusBreakdown} meta={SEND_STATUS_META} pendingLabel="In attesa" />
```

- [ ] **Step 4: Aggiungi state e fetch per POSTAL**

Subito dopo la riga con `const [sendStatusBreakdown, ...] = useState(...)` (riga 973), aggiungi:

```typescript
  const [postalStatusBreakdown, setPostalStatusBreakdown] = useState<Array<{ status: string | null; count: number }> | null>(null);
```

In `handleCampaignClick`, aggiungi il reset dopo `setSendStatusBreakdown(null);` (riga 3603):

```typescript
    setPostalStatusBreakdown(null);
```

E la chiamata fetch dopo `fetchSendStatusBreakdown(id);` (riga 3612):

```typescript
    fetchPostalStatusBreakdown(id);
```

Subito dopo la funzione `fetchSendStatusBreakdown` (dopo la sua chiusura, circa riga 3645), aggiungi:

```typescript
  const fetchPostalStatusBreakdown = async (id: string) => {
    try {
      const res = await apiFetch(`/campaigns/${id}/postal-status-breakdown`);
      if (!res.ok) return;
      setPostalStatusBreakdown(await res.json());
    } catch {
      // Non bloccante: il dettaglio campagna resta usabile senza la barra.
    }
  };
```

- [ ] **Step 5: Aggiungi la sezione barra POSTAL nel rendering**

Subito dopo il blocco `{campaign.channelType !== 'SEND' && campaign.channelConfig?.['protocolla'] === true && campaignSendStageCounts && ( ... )}` (righe 7947-7965 circa, blocco "Stato Protocollazione"), aggiungi:

```typescript
                        {campaign.channelType === 'POSTAL' && postalStatusBreakdown && (
                          <div className="mt-4 border-top pt-3">
                            <h4 className="small fw-bold mb-2">
                              <i className="fas fa-chart-bar me-1 text-primary"></i>Andamento Invio POSTAL
                            </h4>
                            <ChannelStatusBar breakdown={postalStatusBreakdown} meta={POSTAL_STATUS_META} pendingLabel="In corso" />
                          </div>
                        )}
```

- [ ] **Step 6: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 7: Verifica manuale in browser**

Apri il portale admin (`http://localhost:3000`), vai su una campagna POSTAL esistente, apri il dettaglio: verifica che compaia "Andamento Invio POSTAL" con la barra segmentata. Verifica che una campagna SEND mostri ancora "Andamento Invio SEND" (nessuna regressione dal refactor del componente).

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend): generalizza barra stato in ChannelStatusBar, aggiungi sezione POSTAL"
```

---

### Task 10: Frontend — 2 bottoni export (Attuale/Storico) per POSTAL

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:2799-2819` (nuova funzione export), `:8113-8127` (bottoni)

**Interfaces:**
- Consumes: endpoint `GET /campaigns/:id/export-postal-report-attuale.csv`, `GET /campaigns/:id/export-postal-report-storico.csv` (Task 8).

- [ ] **Step 1: Aggiungi `handleExportPostalReport`**

Subito dopo la chiusura di `handleExportSendReport` (dopo la riga 2819), aggiungi:

```typescript
  const handleExportPostalReport = async (variant: 'attuale' | 'storico') => {
    if (!campaign) return;
    try {
      const res = await apiFetch(`/campaigns/${campaign.id}/export-postal-report-${variant}.csv`);
      if (!res.ok) {
        alert('Errore durante il download del report');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', `report_postal_${variant}_campagna_${campaign.id.slice(0, 8)}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch {
      alert('Errore durante il download del report');
    }
  };
```

- [ ] **Step 2: Estendi la logica condizionale dei bottoni**

Sostituisci il blocco (righe 8113-8127):

```typescript
                          {(campaign?.totalRecipients ?? 0) > 0 && campaign.channelType !== 'SEND' && (
                            <button className="btn btn-sm btn-outline-primary py-1" onClick={handleExportDownloadReport} title="Esporta Report CSV">
                              <i className="fas fa-file-excel me-1"></i> Esporta Report Download
                            </button>
                          )}
                          {(campaign?.totalRecipients ?? 0) > 0 && campaign.channelType === 'SEND' && (
                            <div className="btn-group" role="group">
                              <button className="btn btn-sm btn-outline-primary py-1" onClick={() => handleExportSendReport('attuale')} title="Esporta stato attuale">
                                <i className="fas fa-file-excel me-1"></i> Attuale
                              </button>
                              <button className="btn btn-sm btn-outline-primary py-1" onClick={() => handleExportSendReport('storico')} title="Esporta storico completo">
                                <i className="fas fa-clock-rotate-left me-1"></i> Storico
                              </button>
                            </div>
                          )}
```

con:

```typescript
                          {(campaign?.totalRecipients ?? 0) > 0 && campaign.channelType !== 'SEND' && campaign.channelType !== 'POSTAL' && (
                            <button className="btn btn-sm btn-outline-primary py-1" onClick={handleExportDownloadReport} title="Esporta Report CSV">
                              <i className="fas fa-file-excel me-1"></i> Esporta Report Download
                            </button>
                          )}
                          {(campaign?.totalRecipients ?? 0) > 0 && campaign.channelType === 'SEND' && (
                            <div className="btn-group" role="group">
                              <button className="btn btn-sm btn-outline-primary py-1" onClick={() => handleExportSendReport('attuale')} title="Esporta stato attuale">
                                <i className="fas fa-file-excel me-1"></i> Attuale
                              </button>
                              <button className="btn btn-sm btn-outline-primary py-1" onClick={() => handleExportSendReport('storico')} title="Esporta storico completo">
                                <i className="fas fa-clock-rotate-left me-1"></i> Storico
                              </button>
                            </div>
                          )}
                          {(campaign?.totalRecipients ?? 0) > 0 && campaign.channelType === 'POSTAL' && (
                            <div className="btn-group" role="group">
                              <button className="btn btn-sm btn-outline-primary py-1" onClick={() => handleExportPostalReport('attuale')} title="Esporta stato attuale">
                                <i className="fas fa-file-excel me-1"></i> Attuale
                              </button>
                              <button className="btn btn-sm btn-outline-primary py-1" onClick={() => handleExportPostalReport('storico')} title="Esporta storico completo">
                                <i className="fas fa-clock-rotate-left me-1"></i> Storico
                              </button>
                            </div>
                          )}
```

- [ ] **Step 3: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 4: Verifica manuale in browser**

Su una campagna POSTAL: verifica che appaiano i 2 bottoni "Attuale"/"Storico" (non più "Esporta Report Download"), che entrambi scarichino un CSV valido apribile (controllare le intestazioni colonne, incluse le 14 colonne data nello Storico). Su una campagna SEND: verifica che i suoi bottoni Attuale/Storico restino invariati. Su una campagna EMAIL/PEC/APP_IO: verifica che il vecchio bottone "Esporta Report Download" sia ancora presente e funzionante.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend): export CSV POSTAL attuale/storico al posto del report generico"
```

---

## Self-Review

**Copertura spec:**
- Data model (1 colonna jsonb, append-only) → Task 1. ✅
- Storico costruito da noi (GBC non lo fornisce), append su transizione → Task 2. ✅
- Primo stato scritto al momento dell'invio (non solo dal cron) → Task 3. ✅
- Endpoint breakdown per barra → Task 6, 8. ✅
- Barra impilata frontend, generalizzata da SEND, nuova sezione POSTAL → Task 9. ✅
- CSV "Attuale" (stato+data corrente+IDPRO+errore+Esito App IO condizionale) → Task 7, 8, 10. ✅
- CSV "Storico" (14 colonne data, PRIMA occorrenza per stato) → Task 7, 8, 10. ✅
- Edge case: invio fallito prima di GBC, campagna vuota, niente co-consegna App IO, stato ripetuto (Rimandato) → coperti dai default (`?? []`, `?? null`, colonna omessa se `!hasAppIoCoDelivery`, mappa "prima occorrenza") e dai test Task 2/6/7. ✅
- Meccanismo stop-poll invariato (`TERMINAL_STATUSES`) → nessuna modifica, confermato in Task 2. ✅
- Il generico "Download per Canale"/report per POSTAL non ha più senso: già risolto lato frontend nel lavoro SEND precedente (grafico "Download per Canale" mostrato solo per EMAIL/PEC/APP_IO) — Task 10 rimuove anche il bottone "Esporta Report Download" per POSTAL, coerente. ✅

**Placeholder scan:** nessun TBD/TODO, ogni step ha codice completo.

**Coerenza tipi:** `PostalReportRowDto`/`PostalReportDto` (Task 5) usati identici in Task 6 (service), Task 7 (CSV builder) e nei test — stessi nomi di campo (`postalStatusHistory`, `codiceErrore`, `descrizioneErrore`, `appIoOutcome`) in tutti i task. `ChannelStatusBar` (Task 9) usato identicamente per SEND (`meta={SEND_STATUS_META}`) e POSTAL (`meta={POSTAL_STATUS_META}`), stessa prop `pendingLabel` differenziata ("In attesa" vs "In corso") coerente con le label già esistenti per stato assente in `SendStatusBadge`/`PostalStatusBadge`.

**Deviazione rispetto allo spec originale:** lo spec (`docs/superpowers/specs/2026-07-16-postal-status-tracking-design.md`) indicava `postal.strategy.ts` come punto di scrittura del primo stato — verificato sul codice reale che il punto corretto è `notification.processor.ts` (unico punto con accesso ad `attemptRepo` dopo `strategy.send()`, stesso luogo che già scrive `postalTrackingId` oggi). Il piano (Task 3) corregge questo riferimento sulla base del codice effettivo, non della descrizione approssimativa in fase di brainstorming.
