# Invio Notifica di Prova — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prima di lanciare una campagna massiva, l'operatore deve poter verificare l'esito reale dell'invio (email/PEC ricevuta, notifica App IO, esito SEND su PN, esito POSTAL su GlobalCom) su un CF/destinazione di comodo, usando esattamente lo stesso motore/queue/strategy della campagna reale — non un percorso parallelo che rischia di comportarsi diversamente.

**Architettura:** Il wizard passa da 5 a 7 step (nuovo step "Upload Allegati" inserito prima del riepilogo, nuovo step "Test" raggiungibile dal riepilogo). Un "invio di prova" crea/riusa una `Campaign` figlia reale (`isTest=true`, `parentCampaignId`), con allegati copiati fisicamente dalla cartella della madre e un singolo `Recipient` con CF/destinazione sovrascritti dall'operatore — poi passa dagli stessi `createAttemptsAndEnqueue()`/strategy/queue della campagna reale. La campagna figlia non ha ciclo di vita DRAFT→QUEUED→COMPLETED proprio: resta `QUEUED` e accoglie invii di prova ripetuti finché la madre non raggiunge `COMPLETED`, momento in cui viene cancellata a cascata.

**Tech Stack:** NestJS 10 + TypeORM (backend), React 19 + TypeScript (frontend-admin), Jest.

## Global Constraints

- Spec di riferimento: `docs/superpowers/specs/2026-07-19-invio-notifica-di-prova-design.md`.
- Nessun endpoint di invio effimero: si riusa interamente `Campaign`/`Recipient`/`NotificationAttempt`/queue esistenti.
- Nessun nuovo valore in `CampaignStatus`. `isTest=true` esclude sempre dal completamento automatico e dai contatori/KPI aggregati.
- Allegati della campagna test: copia fisica separata (`uploads/<testCampaignId>/`), mai riferimento diretto ai file della madre.
- Salvataggio DRAFT della madre avviene alla transizione step4→step5 (Upload Allegati), non più solo al lancio finale.
- `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` per i test backend — dopo ogni task backend, esegui la suite COMPLETA (non un pattern mirato), il repo ha 1 solo fallimento noto pre-esistente (`app.controller.spec.ts` `isLdapMock`).
- `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` per verificare i task frontend (nessuna suite unit test frontend in questo repo).
- Ogni nuovo punto che chiama `notificationQueues.addBulk` deve passare `opts.jobId = attemptId` (pattern jobId=attemptId, vedi CLAUDE.md).

---

### Task 1: Migration — colonne `is_test`/`parent_campaign_id` su `campaigns`

**Files:**
- Create: `apps/backend/src/database/migrations/1785000000000-AddTestCampaignColumns.ts`
- Modify: `apps/backend/src/database/database.module.ts` (registrare la nuova migration nell'array `migrations`)

**Interfaces:**
- Produces: colonne `campaigns.is_test boolean not null default false`, `campaigns.parent_campaign_id uuid nullable` con FK self-reference `ON DELETE CASCADE` (backstop DB-level: se in futuro una campagna madre viene cancellata senza passare dal metodo `remove()` di Task 6, la campagna figlia non resta orfana in DB — i file su disco restano comunque, ripuliti dal cron "orphan cleanup" già esistente).

- [ ] **Step 1: Genera lo scheletro migration su un DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_gen;"
```

- [ ] **Step 2: Scrivi la migration a mano** (pattern da `1784200000000-AddPostalStatusColumns.ts`, aggiungendo anche il vincolo FK)

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTestCampaignColumns1785000000000 implements MigrationInterface {
    name = 'AddTestCampaignColumns1785000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "campaigns" ADD "is_test" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "campaigns" ADD "parent_campaign_id" uuid`);
        await queryRunner.query(`ALTER TABLE "campaigns" ADD CONSTRAINT "FK_campaigns_parent_campaign_id" FOREIGN KEY ("parent_campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "campaigns" DROP CONSTRAINT "FK_campaigns_parent_campaign_id"`);
        await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN "parent_campaign_id"`);
        await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN "is_test"`);
    }
}
```

- [ ] **Step 3: Esegui la migration sul DB temporaneo e verifica**

```bash
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d migration_gen -c "\d campaigns" 
```

Expected: output mostra `is_test` (boolean, not null, default false) e `parent_campaign_id` (uuid) con il vincolo FK elencato in fondo.

- [ ] **Step 4: Pulisci il DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_gen;"
```

- [ ] **Step 5: Registra la migration in `database.module.ts`**

Apri `apps/backend/src/database/database.module.ts`, trova l'array `migrations: [...]` (contiene già `CreateEnrichmentJobs1784900000000` come ultimo elemento) e aggiungi in coda:

```ts
    AddTestCampaignColumns1785000000000,
```

Aggiungi anche l'import in cima al file, accanto agli altri import di migration:

```ts
import { AddTestCampaignColumns1785000000000 } from './migrations/1785000000000-AddTestCampaignColumns';
```

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/database/migrations/1785000000000-AddTestCampaignColumns.ts apps/backend/src/database/database.module.ts
git commit -m "feat(backend): migration colonne is_test/parent_campaign_id su campaigns"
```

---

### Task 2: Entity `Campaign` — campi `isTest`/`parentCampaignId`

**Files:**
- Modify: `apps/backend/src/entities/campaign.entity.ts`

**Interfaces:**
- Produces: `Campaign.isTest: boolean`, `Campaign.parentCampaignId: string | null` — usati da Task 4/5/6/7 e dal frontend (Task 12).
- Consumes: colonne DB da Task 1.

- [ ] **Step 1: Aggiungi i due campi all'entity**

In `apps/backend/src/entities/campaign.entity.ts`, subito dopo il campo `completedAt`:

```ts
  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @Column({ type: 'boolean', name: 'is_test', default: false })
  isTest!: boolean;

  @Column({ type: 'uuid', name: 'parent_campaign_id', nullable: true })
  parentCampaignId!: string | null;

  @OneToMany('Recipient', 'campaign')
  recipients!: Recipient[];
```

(la riga `@OneToMany('Recipient', 'campaign') recipients!: Recipient[];` esiste già come ultimo membro della classe — sposta semplicemente i due nuovi campi appena sopra di essa, non duplicarla).

- [ ] **Step 2: Type-check**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore (campi opzionali, non rompono altri consumer dell'entity).

- [ ] **Step 3: Riavvia il backend per applicare lo schema in dev** (`synchronize` in dev, la migration è comunque necessaria per prod — vedi Task 1)

```bash
docker compose restart backend
```

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/entities/campaign.entity.ts
git commit -m "feat(backend): campi isTest/parentCampaignId su entity Campaign"
```

---

### Task 3: Estrai le validazioni di `launch()` in helper condivisi

Refactor puro (nessun cambio di comportamento) per permettere a `launchTestSend()` (Task 4) di riusare esattamente le stesse validazioni di `launch()` senza duplicare codice.

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts` (verifica che i test esistenti su `launch()` restino verdi — non serve aggiungerne di nuovi qui, il comportamento esterno non cambia)

**Interfaces:**
- Produces: `private assertSendProtocolConfigured(campaign: Campaign): void` (lancia `BadRequestException` se SEND senza `channelConfig.protocolla===true`), `private async checkAttachmentsBlocking(campaign: Campaign): Promise<{ blocked: true; message: string } | null>` (allegati mancanti/obbligatori per SEND/POSTAL) — usati da Task 4.
- Consumes: `resolveAttachmentsConfig`, `getUploadsDir`, `this.findMissingAttachments` (esistenti, invariati).

- [ ] **Step 1: Esegui la suite completa PRIMA del refactor per avere una baseline**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso identico set di risultati della baseline nota in CLAUDE.md (1 solo fallimento pre-esistente, `app.controller.spec.ts`).

- [ ] **Step 2: Estrai i due helper**

In `apps/backend/src/campaigns/campaigns.service.ts`, subito PRIMA del metodo `launch()`, aggiungi:

```ts
  private assertSendProtocolConfigured(campaign: Campaign): void {
    if (campaign.channelType === 'SEND' && campaign.channelConfig?.['protocolla'] !== true) {
      throw new BadRequestException(
        'Protocollazione obbligatoria per SEND: channelConfig.protocolla deve essere true',
      );
    }
  }

  private async checkAttachmentsBlocking(campaign: Campaign): Promise<{ blocked: true; message: string } | null> {
    if (
      (campaign.channelType === 'SEND' || campaign.channelType === 'POSTAL') &&
      resolveAttachmentsConfig(campaign.channelConfig).length === 0
    ) {
      return {
        blocked: true,
        message: `Impossibile avviare: allegato obbligatorio per il canale ${campaign.channelType}. Configuralo al Passo 3 prima di rilanciare.`,
      };
    }

    const missingAttachments = await this.findMissingAttachments(campaign);
    if (missingAttachments.length > 0) {
      const sample = missingAttachments
        .slice(0, 5)
        .map((m) => `${m.expectedFilename} (CF ${m.codiceFiscale})`)
        .join(', ');
      const more = missingAttachments.length > 5 ? ', …' : '';

      const dir = getUploadsDir(campaign.id);
      const presentFiles = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      const presentList =
        presentFiles.length > 0
          ? presentFiles.slice(0, 10).join(', ') + (presentFiles.length > 10 ? '...' : '')
          : 'nessuno';

      return {
        blocked: true,
        message: `Impossibile avviare: ${missingAttachments.length} allegato/i mancante/i rispetto alla mappatura configurata — es. ${sample}${more}. Carica i file mancanti prima di rilanciare. (Presenti in cartella: ${presentList})`,
      };
    }
    return null;
  }
```

- [ ] **Step 3: Sostituisci i due blocchi inline in `launch()` con chiamate agli helper**

Nel metodo `launch()`, il blocco:

```ts
    if (campaign.channelType === 'SEND' && campaign.channelConfig?.['protocolla'] !== true) {
      await this.campaignRepo.update({ id: campaignId }, { status: CampaignStatus.DRAFT });
      throw new BadRequestException('Protocollazione obbligatoria per SEND: channelConfig.protocolla deve essere true');
    }
```

diventa:

```ts
    try {
      this.assertSendProtocolConfigured(campaign);
    } catch (err) {
      await this.campaignRepo.update({ id: campaignId }, { status: CampaignStatus.DRAFT });
      throw err;
    }
```

e i due blocchi successivi (controllo allegati vuoti per SEND/POSTAL + controllo `findMissingAttachments`) vengono sostituiti da:

```ts
    const attachmentsBlock = await this.checkAttachmentsBlocking(campaign);
    if (attachmentsBlock) {
      await this.campaignRepo.update({ id: campaignId }, { status: CampaignStatus.DRAFT });
      return { launched: 0, campaignId, ...attachmentsBlock };
    }
```

Il resto di `launch()` (caricamento recipients PENDING, INAD, `createAttemptsAndEnqueue`) resta invariato.

- [ ] **Step 4: Esegui la suite completa e verifica identico esito alla baseline dello Step 1**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso set di risultati dello Step 1 — nessuna regressione, nessun nuovo fallimento.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts
git commit -m "refactor(backend): estrae validazioni launch() in helper condivisi"
```

---

### Task 4: `launchTestSend()` — servizio, DTO, endpoint

**Files:**
- Create: `apps/backend/src/campaigns/dto/test-send.dto.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Test: Create `apps/backend/src/campaigns/campaigns.service.spec.ts` (nuovo `describe('launchTestSend', ...)` — se il file esiste già, aggiungi il blocco; verificare struttura mock esistente prima di scrivere i test)

**Interfaces:**
- Produces: `CampaignsService.launchTestSend(parentCampaignId: string, dto: TestSendDto): Promise<{ attemptId: string; testCampaignId: string; blocked?: boolean; message?: string }>`. Endpoint `POST /admin/campaigns/:id/test-send`.
- Consumes: `assertSendProtocolConfigured`, `checkAttachmentsBlocking` (Task 3), `createAttemptsAndEnqueue` (esistente, privato, già nella stessa classe), `Campaign.isTest`/`parentCampaignId` (Task 2).

- [ ] **Step 1: Crea il DTO**

```ts
// apps/backend/src/campaigns/dto/test-send.dto.ts
import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

/**
 * Il campo `extraData` è l'intera riga del primo destinatario del CSV
 * (stesse chiavi = nomi colonna raw usati da wizMapping/labelColumn/
 * attachment config), con CF/email/pec/colonne indirizzo postale già
 * sovrascritte dall'operatore lato frontend — il backend non conosce e
 * non deve dedurre quali colonne mappano a cosa, riceve il dato già pronto.
 */
export class TestSendDto {
  @IsString()
  @IsNotEmpty()
  codiceFiscale!: string;

  @IsString()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  pec?: string;

  @IsObject()
  extraData!: Record<string, string>;
}
```

- [ ] **Step 2: Scrivi il test (fallisce: metodo non esiste)**

Verifica prima se `apps/backend/src/campaigns/campaigns.service.spec.ts` esiste e qual è il pattern di mock dei repository (`campaignRepo`, `recipientRepo`, `attemptRepo`, `notificationQueues`) già usato per testare `launch()` — riusa lo stesso setup. Aggiungi:

```ts
  describe('launchTestSend', () => {
    it('crea una campagna figlia isTest=true al primo invio di prova', async () => {
      const parent = {
        id: 'parent-1',
        name: 'Campagna TARI 2026',
        channelType: 'EMAIL',
        channelConfig: { subject: 'Avviso', body: 'Corpo' },
        createdBy: 'operator1',
      };
      mockCampaignRepo.findOneBy
        .mockResolvedValueOnce(parent) // findOneBy({id: parentCampaignId})
        .mockResolvedValueOnce(null); // findOneBy({parentCampaignId, isTest: true}) -> nessun child esistente
      mockCampaignRepo.create.mockReturnValue({ id: 'child-1', ...parent, isTest: true, parentCampaignId: 'parent-1' });
      mockCampaignRepo.save.mockResolvedValue({ id: 'child-1', ...parent, isTest: true, parentCampaignId: 'parent-1' });
      mockRecipientRepo.create.mockReturnValue({ id: 'recipient-1' });
      mockRecipientRepo.save.mockResolvedValue({ id: 'recipient-1' });

      const insertResult = { raw: [{ id: 'attempt-1' }] };
      mockAttemptRepo.createQueryBuilder.mockReturnValue({
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(insertResult),
      });
      mockRecipientRepo.update.mockResolvedValue(undefined);
      mockNotificationQueues.addBulk.mockResolvedValue(undefined);

      const dto = { codiceFiscale: 'RSSMRA80A01H501U', email: 'test@example.com', extraData: { full_name: 'Mario Rossi' } };
      const result = await service.launchTestSend('parent-1', dto);

      expect(result.testCampaignId).toBe('child-1');
      expect(result.attemptId).toBeTruthy();
      expect(mockCampaignRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ isTest: true, parentCampaignId: 'parent-1', name: '[TEST] Campagna TARI 2026' }),
      );
    });

    it('riusa la campagna figlia esistente al secondo invio di prova, aggiornando channelConfig', async () => {
      const parent = {
        id: 'parent-1',
        name: 'Campagna TARI 2026',
        channelType: 'EMAIL',
        channelConfig: { subject: 'Nuovo oggetto' },
        createdBy: 'operator1',
      };
      const existingChild = { id: 'child-1', isTest: true, parentCampaignId: 'parent-1', channelType: 'EMAIL', channelConfig: {} };
      mockCampaignRepo.findOneBy.mockResolvedValueOnce(parent).mockResolvedValueOnce(existingChild);
      mockCampaignRepo.update.mockResolvedValue(undefined);
      mockRecipientRepo.create.mockReturnValue({ id: 'recipient-2' });
      mockRecipientRepo.save.mockResolvedValue({ id: 'recipient-2' });

      const insertResult = { raw: [{ id: 'attempt-2' }] };
      mockAttemptRepo.createQueryBuilder.mockReturnValue({
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(insertResult),
      });
      mockRecipientRepo.update.mockResolvedValue(undefined);
      mockNotificationQueues.addBulk.mockResolvedValue(undefined);

      const dto = { codiceFiscale: 'VRDLGU85B02H501X', extraData: {} };
      const result = await service.launchTestSend('parent-1', dto);

      expect(result.testCampaignId).toBe('child-1');
      expect(mockCampaignRepo.create).not.toHaveBeenCalled();
      expect(mockCampaignRepo.update).toHaveBeenCalledWith({ id: 'child-1' }, { channelConfig: parent.channelConfig });
    });

    it('SEND senza protocolla lancia BadRequestException, nessuna campagna figlia creata', async () => {
      const parent = { id: 'parent-1', name: 'Campagna SEND', channelType: 'SEND', channelConfig: {}, createdBy: 'operator1' };
      mockCampaignRepo.findOneBy.mockResolvedValueOnce(parent);

      await expect(service.launchTestSend('parent-1', { codiceFiscale: 'RSSMRA80A01H501U', extraData: {} }))
        .rejects.toThrow('Protocollazione obbligatoria per SEND');
      expect(mockCampaignRepo.create).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 3: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: FAIL — `service.launchTestSend is not a function`.

- [ ] **Step 4: Implementa `launchTestSend()`**

Aggiungi in `apps/backend/src/campaigns/campaigns.service.ts`, subito dopo `launch()`:

```ts
  async launchTestSend(
    parentCampaignId: string,
    dto: TestSendDto,
  ): Promise<{ attemptId: string; testCampaignId: string; blocked?: boolean; message?: string }> {
    const parent = await this.campaignRepo.findOneBy({ id: parentCampaignId });
    if (!parent) throw new NotFoundException(`Campaign ${parentCampaignId} not found`);

    this.assertSendProtocolConfigured(parent);

    let child = await this.campaignRepo.findOneBy({ parentCampaignId, isTest: true });
    if (!child) {
      const created = this.campaignRepo.create({
        name: `[TEST] ${parent.name}`,
        channelType: parent.channelType,
        channelConfig: parent.channelConfig,
        status: CampaignStatus.QUEUED,
        createdBy: parent.createdBy,
        isTest: true,
        parentCampaignId,
      });
      child = await this.campaignRepo.save(created);
    } else {
      await this.campaignRepo.update({ id: child.id }, { channelConfig: parent.channelConfig });
      child = { ...child, channelConfig: parent.channelConfig };
    }

    // Copia fisica isolata: la campagna test non deve mai riferire i file
    // della madre, altrimenti la sua retention/cancellazione rischierebbe
    // di cancellare allegati ancora necessari alla bozza madre non lanciata.
    const parentDir = getUploadsDir(parentCampaignId);
    const childDir = getUploadsDir(child.id);
    if (fs.existsSync(parentDir)) {
      fs.rmSync(childDir, { recursive: true, force: true });
      fs.mkdirSync(childDir, { recursive: true });
      fs.cpSync(parentDir, childDir, { recursive: true });
    }

    const attachmentsBlock = await this.checkAttachmentsBlocking(child);
    if (attachmentsBlock) {
      return { attemptId: '', testCampaignId: child.id, ...attachmentsBlock };
    }

    const recipient = this.recipientRepo.create({
      campaignId: child.id,
      codiceFiscale: dto.codiceFiscale,
      email: dto.email ?? null,
      pec: dto.pec ?? null,
      fullName: dto.extraData['full_name'] ?? null,
      extraData: dto.extraData,
      status: RecipientStatus.PENDING,
    });
    const savedRecipient = await this.recipientRepo.save(recipient);

    const { launched } = await this.createAttemptsAndEnqueue(child, [{ id: savedRecipient.id }]);
    if (launched === 0) {
      throw new BadRequestException('Invio di prova non accodato');
    }

    const attempt = await this.attemptRepo.findOne({
      where: { recipientId: savedRecipient.id },
      order: { createdAt: 'DESC' },
    });

    return { attemptId: attempt!.id, testCampaignId: child.id };
  }
```

Aggiungi l'import del DTO in cima al file, accanto agli altri import di DTO:

```ts
import type { TestSendDto } from './dto/test-send.dto';
```

- [ ] **Step 5: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: PASS su tutti e 3 i nuovi test.

- [ ] **Step 6: Aggiungi l'endpoint nel controller**

In `apps/backend/src/campaigns/campaigns.controller.ts`, subito dopo il metodo `launch()`, segui lo stesso pattern (guard di classe `@Roles('user', 'admin')`, audit log dopo la chiamata al service):

```ts
  @Post(':id/test-send')
  async testSend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TestSendDto,
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    const result = await this.campaignsService.launchTestSend(id, dto);
    const campaign = await this.campaignsService.findOne(id);
    await this.auditLogsService.log({
      campaignId: id,
      campaignName: campaign.name,
      operator: req.user.username,
      action: 'test_send',
      details: { testCampaignId: result.testCampaignId, codiceFiscale: dto.codiceFiscale },
    });
    return result;
  }
```

Aggiungi l'import del DTO in cima al file:

```ts
import { TestSendDto } from './dto/test-send.dto';
```

(import senza `type` qui, a differenza del service — il controller lo usa come decorator target `@Body() dto: TestSendDto`, serve la classe reale per `class-validator`, coerente con l'import di `CreateCampaignDto` già presente nel controller — verifica il pattern esistente prima di procedere).

- [ ] **Step 7: Esegui la suite completa e type-check**

```bash
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Expected: stesso set di risultati della baseline (Task 3 Step 1), nessun errore di tipo.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/campaigns/dto/test-send.dto.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): endpoint POST /admin/campaigns/:id/test-send"
```

---

### Task 5: Cancellazione automatica campagna test al completamento della madre

**Files:**
- Modify: `apps/backend/src/campaigns/campaign-completion.service.ts`
- Test: `apps/backend/src/campaigns/campaign-completion.service.spec.ts`

**Interfaces:**
- Produces: `CampaignCompletionService.checkAndComplete()` ora cancella a cascata la campagna figlia (se esiste) subito dopo aver marcato la madre `COMPLETED`.
- Consumes: `NotificationAttempt` repository — **già disponibile senza nuova registrazione di modulo**: `channel.module.ts` importa già `TypeOrmModule.forFeature([NotificationAttempt, Campaign, Recipient])` (verificato), basta iniettarlo nel costruttore del servizio.

Nota di design accettata: la cascata qui NON tenta di rimuovere eventuali job BullMQ ancora pendenti della campagna test (a differenza di `cancel()` in `campaigns.service.ts`). Aggiungere `NotificationQueuesService` a `CampaignCompletionService` richiederebbe importare `QueueModule` dentro `ChannelModule`, che creerebbe un import circolare (`CampaignsModule → QueueModule → ChannelModule → QueueModule`, dato che `notification.processor.ts` in `QueueModule` già dipende da `ChannelModule` per le strategy). Un test-send è un singolo invio quasi sempre già terminale (SUCCESS/FAILED) molto prima che una campagna madre bulk raggiunga `COMPLETED`; nel raro caso in cui un job di test sia ancora `QUEUED` quando scatta la cascata, il job troverà `recipientId`/`campaignId` già cancellati quando verrà processato e fallirà con un log — nessun retry storm, nessun impatto sulla madre.

- [ ] **Step 1: Scrivi il test (fallisce: comportamento non implementato)**

Apri `apps/backend/src/campaigns/campaign-completion.service.spec.ts`, guarda il setup esistente dei mock repository per `checkAndComplete()` (probabilmente mock di `campaignRepo`/`recipientRepo` già presenti) e aggiungi:

```ts
  it('cancella a cascata la campagna test collegata quando la madre completa', async () => {
    mockRecipientRepo.count.mockResolvedValue(0); // nessun PENDING/QUEUED residuo
    const updateExec = jest.fn().mockResolvedValue({ affected: 1 });
    mockCampaignRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: updateExec,
    });
    const testChild = { id: 'child-1', parentCampaignId: 'parent-1', isTest: true };
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(testChild); // lookup child by parentCampaignId
    mockAttemptRepo.delete.mockResolvedValue(undefined);
    mockRecipientRepo.delete.mockResolvedValue(undefined);
    mockCampaignRepo.delete.mockResolvedValue(undefined);

    await service.checkAndComplete('parent-1');

    expect(mockCampaignRepo.findOneBy).toHaveBeenCalledWith({ parentCampaignId: 'parent-1', isTest: true });
    expect(mockCampaignRepo.delete).toHaveBeenCalledWith('child-1');
  });

  it('non fa nulla se non esiste campagna test collegata', async () => {
    mockRecipientRepo.count.mockResolvedValue(0);
    const updateExec = jest.fn().mockResolvedValue({ affected: 1 });
    mockCampaignRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: updateExec,
    });
    mockCampaignRepo.findOneBy.mockResolvedValueOnce(null);

    await service.checkAndComplete('parent-1');

    expect(mockCampaignRepo.delete).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaign-completion --maxWorkers=2`
Expected: FAIL — `mockCampaignRepo.delete` non chiamato / `findOneBy` non chiamato con quei parametri (comportamento assente).

- [ ] **Step 3: Implementa la cascata**

In `apps/backend/src/campaigns/campaign-completion.service.ts`, aggiungi l'iniezione del repository `NotificationAttempt` e `getUploadsDir`:

```ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import * as fs from 'fs';
import { In, Repository } from 'typeorm';
import { Campaign, CampaignStatus } from '../entities/campaign.entity';
import { Recipient, RecipientStatus } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { getUploadsDir } from '../attachments/attachment-paths';

@Injectable()
export class CampaignCompletionService {
  constructor(
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
  ) {}

  async checkAndComplete(campaignId: string): Promise<void> {
    const remaining = await this.recipientRepo.count({
      where: { campaignId, status: In([RecipientStatus.PENDING, RecipientStatus.QUEUED]) },
    });
    if (remaining > 0) return;

    const result = await this.campaignRepo
      .createQueryBuilder()
      .update()
      .set({ status: CampaignStatus.COMPLETED, completedAt: new Date() })
      .where('id = :id AND status = :queued', { id: campaignId, queued: CampaignStatus.QUEUED })
      .execute();

    if (result.affected && result.affected > 0) {
      await this.deleteLinkedTestCampaign(campaignId);
    }
  }

  /**
   * Cascata esplicita (non FK ON DELETE, la madre non viene cancellata qui):
   * elimina NotificationAttempt+Recipient+Campaign della campagna test
   * collegata e la sua cartella allegati su disco. Best-effort sui job
   * BullMQ ancora pendenti: non tentato qui, vedi nota nel piano di
   * implementazione (rischio di dipendenza circolare tra moduli).
   */
  private async deleteLinkedTestCampaign(parentCampaignId: string): Promise<void> {
    const child = await this.campaignRepo.findOneBy({ parentCampaignId, isTest: true });
    if (!child) return;

    const recipients = await this.recipientRepo.find({ where: { campaignId: child.id }, select: ['id'] });
    const recipientIds = recipients.map((r) => r.id);
    if (recipientIds.length > 0) {
      await this.attemptRepo.delete({ recipientId: In(recipientIds) });
      await this.recipientRepo.delete({ id: In(recipientIds) });
    }
    await this.campaignRepo.delete(child.id);

    try {
      fs.rmSync(getUploadsDir(child.id), { recursive: true, force: true });
    } catch {
      // best-effort: cartella già assente non è un errore
    }
  }
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest campaign-completion --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Esegui la suite completa**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso set di risultati della baseline, nessuna regressione (in particolare `notification.processor.spec.ts`, `protocollazione.processor.spec.ts`, `send-dispatch.service.spec.ts` che chiamano `checkAndComplete` — verifica che i loro mock di `campaignRepo`/`recipientRepo`/`attemptRepo` continuino a funzionare con il nuovo parametro nel costruttore; se quei file istanziano `CampaignCompletionService` manualmente con `new CampaignCompletionService(a, b)` andranno aggiornati con il terzo argomento mock — pattern gotcha già noto in CLAUDE.md "Nuova dependency in un costruttore").

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/campaigns/campaign-completion.service.ts apps/backend/src/campaigns/campaign-completion.service.spec.ts
git commit -m "feat(backend): cancellazione a cascata campagna test al completamento madre"
```

---

### Task 6: Cancellazione campagna test alla cancellazione esplicita della madre

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: nessuna nuova dipendenza (il metodo `remove()` è già nella stessa classe di `attemptRepo`/`recipientRepo`).

- [ ] **Step 1: Scrivi il test (fallisce: comportamento non implementato)**

```ts
  describe('remove — cascata su campagna test collegata', () => {
    it('cancella anche la campagna test figlia quando esiste', async () => {
      mockCampaignRepo.existsBy.mockResolvedValue(true);
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ id: 'child-1', parentCampaignId: 'parent-1', isTest: true });
      mockRecipientRepo.find.mockResolvedValueOnce([{ id: 'r1' }]);
      mockAttemptRepo.delete.mockResolvedValue(undefined);
      mockRecipientRepo.delete.mockResolvedValue(undefined);
      mockCampaignRepo.delete.mockResolvedValue(undefined);

      await service.remove('parent-1');

      expect(mockCampaignRepo.findOneBy).toHaveBeenCalledWith({ parentCampaignId: 'parent-1', isTest: true });
      expect(mockCampaignRepo.delete).toHaveBeenCalledWith('child-1');
      expect(mockCampaignRepo.delete).toHaveBeenCalledWith('parent-1');
    });
  });
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: FAIL — `mockCampaignRepo.delete` non chiamato con `'child-1'`.

- [ ] **Step 3: Modifica `remove()`**

Il metodo attuale:

```ts
  async remove(campaignId: string): Promise<{ deleted: true }> {
    const exists = await this.campaignRepo.existsBy({ id: campaignId });
    if (!exists) throw new NotFoundException(`Campaign ${campaignId} not found`);

    await fs.promises.rm(getUploadsDir(campaignId), { recursive: true, force: true });
    await this.campaignRepo.delete(campaignId);

    return { deleted: true };
  }
```

diventa:

```ts
  async remove(campaignId: string): Promise<{ deleted: true }> {
    const exists = await this.campaignRepo.existsBy({ id: campaignId });
    if (!exists) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const linkedTestCampaign = await this.campaignRepo.findOneBy({ parentCampaignId: campaignId, isTest: true });
    if (linkedTestCampaign) {
      const testRecipients = await this.recipientRepo.find({ where: { campaignId: linkedTestCampaign.id }, select: ['id'] });
      const testRecipientIds = testRecipients.map((r) => r.id);
      if (testRecipientIds.length > 0) {
        await this.attemptRepo.delete({ recipientId: In(testRecipientIds) });
        await this.recipientRepo.delete({ id: In(testRecipientIds) });
      }
      await this.campaignRepo.delete(linkedTestCampaign.id);
      await fs.promises.rm(getUploadsDir(linkedTestCampaign.id), { recursive: true, force: true });
    }

    await fs.promises.rm(getUploadsDir(campaignId), { recursive: true, force: true });
    await this.campaignRepo.delete(campaignId);

    return { deleted: true };
  }
```

(`In` è già importato in cima al file — usato da `cancel()`.)

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Suite completa**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: baseline invariata.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): remove() cancella a cascata la campagna test collegata"
```

---

### Task 7: Escludi campagne test dai contatori/KPI aggregati

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: nessuna nuova dipendenza. Modifica solo `getGlobalStats()`.

- [ ] **Step 1: Scrivi il test (fallisce: filtro non applicato)**

Verifica il pattern di mock già usato per testare `getGlobalStats()` (query builder concatenato) e aggiungi un'asserzione che il filtro `isTest` è presente in ogni `andWhere`/`where` chain — se il test esistente su `getGlobalStats()` già verifica la sequenza di chiamate al query builder mockato, estendilo così:

```ts
  it('getGlobalStats esclude sempre le campagne isTest=true da ogni query aggregata', async () => {
    // Riusa il mock setup esistente del describe getGlobalStats, poi:
    await service.getGlobalStats();

    // Ognuna delle query builder mockate (campaignRepo, recipientRepo, downloadEventRepo)
    // deve aver ricevuto una chiamata andWhere con la condizione isTest.
    const andWhereCalls = mockCampaignRepo.createQueryBuilder().andWhere.mock.calls.map((c: unknown[]) => c[0]);
    expect(andWhereCalls).toContain('c.isTest = false');
  });
```

Nota: adatta l'asserzione esatta al mock reale del file esistente — se `getGlobalStats()` non era ancora coperto da test in questo file, aggiungi un test minimo end-to-end sul metodo con repository mockati in modo che ogni query builder tracci le chiamate `.andWhere()`.

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: FAIL — il filtro `isTest` non è ancora applicato.

- [ ] **Step 3: Aggiungi il filtro a ciascuna query di `getGlobalStats()`**

In `apps/backend/src/campaigns/campaigns.service.ts`, metodo `getGlobalStats()`, aggiungi `.andWhere('c.isTest = false')` (o `.andWhere('c.is_test = false')` a seconda di come TypeORM espone l'alias colonna — verifica con le altre query nello stesso metodo che già referenziano `c.channelType`/`c.totalRecipients` in camelCase, quindi usa `c.isTest`) subito dopo ogni `.where(range.sql, range.params)` esistente. Le 7 query da modificare sono: `totalsRow`, `totalDownloaded` (alias `c` via `innerJoin('r.campaign', 'c')`), `sentTrendRows`, `downloadedTrendRows` (alias `c`), `channelRows`, `downloadChannelRows` (alias `c` via doppio join), `leaderboardRows`, `neverDownloadedCount` (alias `c`).

Esempio per `totalsRow`:

```ts
    const totalsRow = await this.campaignRepo
      .createQueryBuilder('c')
      .select('COALESCE(SUM(c.totalRecipients), 0)', 'totalRecipients')
      .addSelect('COALESCE(SUM(c.sentCount), 0)', 'totalSent')
      .addSelect('COALESCE(SUM(c.failedCount), 0)', 'totalFailed')
      .where(range.sql, range.params)
      .andWhere('c.isTest = false')
      .getRawOne<{ totalRecipients: string; totalSent: string; totalFailed: string }>();
```

Replica lo stesso `.andWhere('c.isTest = false')` per le altre 6 query, sempre subito dopo la `.where(range.sql, range.params)`/`.andWhere(range.sql, range.params)` esistente in ciascuna.

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Suite completa**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: baseline invariata.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "fix(backend): getGlobalStats esclude campagne isTest dai contatori aggregati"
```

---

### Task 8: Frontend — sposta upload allegati in nuovo Step 5 dedicato

Il wizard passa da 5 a 7 step logici. Questo task introduce il nuovo step "Upload Allegati" tra l'attuale step 4 (Template & Anteprima) e l'attuale step 5 (Riepilogo & Invio, che diventa step 6 nel Task 9), spostando la logica di upload allegati chunked fuori da `handleWizLaunch` (dove oggi avviene solo al lancio finale) in un handler dedicato eseguito a questo nuovo step.

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Produces: nuovo handler `handleWizUploadAttachments(): Promise<void>` — carica (chunked) gli allegati correnti (stato `wizAttachments`) verso `/campaigns/:id/attachments/upload`, salvando prima la campagna come DRAFT se non ancora persistita (stesso pattern di `handleSaveWizardDraft`).
- Consumes: stato esistente `wizAttachments` (File object in memoria), `wizStep`, `handleSaveWizardDraft` (righe ~3976-4031), `buildWizChannelConfigDraft` (righe ~3913-3974), `ADMIN_API_BASE`.

- [ ] **Step 1: Individua nel codice attuale il blocco di upload allegati dentro `handleWizLaunch`**

Apri `apps/frontend-admin/src/App.tsx`, cerca `handleWizLaunch` (circa riga 4033). Al suo interno, dopo l'upload del CSV destinatari e prima della chiamata a `/launch`, c'è il blocco che carica gli allegati chunked verso `POST /campaigns/:id/attachments/upload` (circa riga 4189-4216, secondo l'esplorazione precedente — usa `initChunkedUpload`/upload a chunk lato client, verificare il nome esatto della funzione client-side chunker già usata anche per il CSV, probabilmente condivisa). Annota il corpo esatto di questo blocco: servirà quasi identico nel nuovo handler.

- [ ] **Step 2: Crea `handleWizUploadAttachments`**

Subito dopo la definizione di `handleSaveWizardDraft` (circa riga 4031), aggiungi:

```tsx
  const handleWizUploadAttachments = async (): Promise<void> => {
    setWizError(null);
    setWizSubmitting(true);
    try {
      let campaignId = wizCampaignId;
      if (!campaignId) {
        campaignId = await handleSaveWizardDraft();
        if (!campaignId) {
          throw new Error('Impossibile salvare la bozza prima di caricare gli allegati.');
        }
      }

      // Stesso pattern di upload chunked usato oggi in handleWizLaunch per gli
      // allegati (chunk client-side ~512KB, sotto il limite del reverse proxy
      // esterno ~1MB) — spostato qui perché ora è un passo esplicito del
      // wizard invece che parte del lancio finale.
      for (const attachment of wizAttachments) {
        await uploadFileInChunks(
          attachment.file,
          `${ADMIN_API_BASE}/campaigns/${campaignId}/attachments/upload`,
          token,
        );
      }

      setWizStep(6);
    } catch (err) {
      setWizError(err instanceof Error ? err.message : 'Errore durante il caricamento degli allegati.');
    } finally {
      setWizSubmitting(false);
    }
  };
```

Nota: `uploadFileInChunks` è il nome della funzione già usata da `handleWizLaunch` per il CSV/allegati (verificare il nome esatto letto allo Step 1 — se si chiama diversamente, es. `chunkedUpload` o `uploadInChunks`, usa quel nome). `wizCampaignId`, `wizAttachments`, `wizSubmitting`, `wizError`, `token` sono stati già esistenti nel componente wizard.

- [ ] **Step 3: Rimuovi il blocco di upload allegati da `handleWizLaunch`**

Nel corpo di `handleWizLaunch` (circa righe 4189-4216), elimina il blocco che caricava gli allegati chunked (ora fatto dal nuovo Step 5) — `handleWizLaunch` continua a fare: crea/aggiorna Campaign, upload CSV destinatari, chiamata `/launch`. Non deve più toccare `/attachments/upload`.

- [ ] **Step 4: Aggiorna lo stepper (array step 1-5 → 1-7)**

Trova il blocco JSX dello stepper (circa righe 5097-5102) che mappa un array di etichette step. Aggiungi una nuova entry "Upload Allegati" in posizione 5 (dopo "Template & Anteprima", prima di "Riepilogo & Invio" che diventa "Anteprima e Invio" in posizione 6) e una entry "Test" in posizione 7 — quest'ultima va marcata come raggiungibile solo tramite navigazione esplicita dal bottone "Avvia Test" (Task 10), non cliccabile direttamente dallo stepper come gli altri step. Se lo stepper esistente rende ogni step come pallino cliccabile, aggiungi una condizione tipo `step.number !== 7` per il click handler sul pallino 7 (lo step 7 non è raggiungibile navigando avanti/indietro liberamente, solo dal bottone dedicato in step 6).

- [ ] **Step 5: Aggiungi il nuovo blocco JSX per lo Step 5 "Upload Allegati"**

Individua dove finisce il JSX dello step 4 (Template & Anteprima, circa riga 6037+) e dove inizia l'attuale step 5 (Riepilogo & Invio, circa riga 6332). Inserisci tra i due un nuovo blocco condizionato su `wizStep === 5`:

```tsx
{wizStep === 5 && (
  <div className="wizard-step">
    <h3>Upload Allegati</h3>
    <p>Carica gli allegati configurati al Passo 3 sul server prima di procedere. Necessario per poter usare "Avvia Test" al passo successivo.</p>
    {/* Riusa qui lo stesso componente/lista file già usato per raccogliere wizAttachments negli step precedenti, se esiste una UI di selezione file condivisa — altrimenti mostra solo l'elenco file già mappati con stato di upload. */}
    <ul>
      {wizAttachments.map((a) => (
        <li key={a.key}>{a.label} — {a.file.name}</li>
      ))}
    </ul>
    {wizError && <div className="alert alert-danger">{wizError}</div>}
    <div className="wizard-actions">
      <button type="button" onClick={() => setWizStep(4)} disabled={wizSubmitting}>Indietro</button>
      <button type="button" onClick={handleWizUploadAttachments} disabled={wizSubmitting}>
        {wizSubmitting ? 'Caricamento...' : 'Carica allegati e continua'}
      </button>
    </div>
  </div>
)}
```

Adatta le classi CSS (`wizard-step`, `wizard-actions`, `alert alert-danger`) a quelle effettivamente usate negli altri step del wizard — cercale nel blocco dello step 4 esistente prima di scrivere questo JSX, per coerenza visiva.

- [ ] **Step 6: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 7: Verifica manuale nel browser**

Avvia il wizard (`docker compose up -d`, login admin/admin in dev), crea una campagna EMAIL di test, arriva fino allo step 4, verifica che compaia il nuovo step 5 "Upload Allegati" con il bottone che salva la bozza (se non già salvata) e carica gli allegati, poi naviga allo step 6.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): nuovo step wizard Upload Allegati, upload spostato prima del riepilogo"
```

---

### Task 9: Frontend — rinomina Step 6 "Anteprima e Invio", aggiungi bottone "Avvia Test"

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: blocco JSX dell'ex step 5 "Riepilogo & Invio" (Task 8 lo ha lasciato invariato, condizionato ancora su un vecchio indice — va spostato a `wizStep === 6`).
- Produces: bottone "Avvia Test" che naviga a `wizStep === 7` (Task 10).

- [ ] **Step 1: Aggiorna la condizione del blocco JSX esistente**

Il blocco che oggi è condizionato su `wizStep === 5` (Riepilogo & Invio, circa riga 6332 pre-Task 8) va cambiato in `wizStep === 6` — è lo stesso JSX, cambia solo il numero di step. Rinomina anche il titolo visibile da "Riepilogo & Invio" a "Anteprima e Invio" e aggiungi (se non già presente) l'anteprima per singolo destinatario riusando lo stesso componente di preview già usato allo step 4 Template & Anteprima.

- [ ] **Step 2: Aggiungi il bottone "Avvia Test" accanto a "Conferma ed Avvia Campagna"**

Nel blocco `<div className="wizard-actions">` che contiene il bottone `onClick={handleWizLaunch}` (circa riga 6344-6357 pre-Task 8), aggiungi un secondo bottone:

```tsx
<button
  type="button"
  className="btn btn-outline-secondary"
  onClick={() => setWizStep(7)}
  disabled={wizSubmitting || !wizCampaignId}
  title={!wizCampaignId ? 'Completa prima il passo Upload Allegati' : undefined}
>
  Avvia Test
</button>
```

Il bottone è disabilitato se `wizCampaignId` non è ancora impostato (la campagna deve essere già salvata come DRAFT — garantito dal Task 8, che salva alla transizione verso lo step 5).

- [ ] **Step 3: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore (lo step 7 non esiste ancora come blocco JSX, ma `setWizStep(7)` è valido perché `wizStep` è tipizzato come `number`, non un literal union — verificare la dichiarazione `useState` di `wizStep`: se è tipizzata come union stretta tipo `useState<1|2|3|4|5>(1)`, va estesa a `useState<1|2|3|4|5|6|7>(1)` qui prima che compili).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): step 6 Anteprima e Invio, bottone Avvia Test"
```

---

### Task 10: Frontend — nuovo Step 7 "Test"

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Produces: stato `wizTestForm` (CF + campi destinazione per canale), stato `wizTestHistory` (lista invii di prova già effettuati), handler `handleWizTestSend()` che chiama `POST /campaigns/:id/test-send`.
- Consumes: `wizValidRows[0]` (primo record CSV), `wizChannelType` (o come si chiama lo stato canale campagna), `ADMIN_API_BASE`, `token`.

- [ ] **Step 1: Aggiungi gli stati per lo step 7**

Vicino alle altre dichiarazioni `wiz*` `useState` (circa riga 754-781), aggiungi:

```tsx
  const [wizTestForm, setWizTestForm] = useState<{
    codiceFiscale: string;
    email: string;
    pec: string;
    postalAddress: string;
    postalMunicipality: string;
    postalZip: string;
    postalProvince: string;
  }>({ codiceFiscale: '', email: '', pec: '', postalAddress: '', postalMunicipality: '', postalZip: '', postalProvince: '' });
  const [wizTestHistory, setWizTestHistory] = useState<Array<{ attemptId: string; codiceFiscale: string; sentAt: string }>>([]);
  const [wizTestSubmitting, setWizTestSubmitting] = useState(false);
  const [wizTestError, setWizTestError] = useState<string | null>(null);
```

- [ ] **Step 2: Precompila il form quando si entra nello step 7**

Aggiungi un `useEffect` (vicino agli altri effect del wizard) che, quando `wizStep` diventa `7`, precompila `wizTestForm` dal primo record valido:

```tsx
  useEffect(() => {
    if (wizStep !== 7 || wizValidRows.length === 0) return;
    const first = wizValidRows[0];
    setWizTestForm((prev) => ({
      ...prev,
      codiceFiscale: first[wizMapping.codice_fiscale] ?? '',
      email: first[wizMapping.email] ?? '',
      pec: first[wizMapping.pec] ?? '',
      postalAddress: wizPostalAddressColumn ? (first[wizPostalAddressColumn] ?? '') : '',
      postalMunicipality: wizPostalMunicipalityColumn ? (first[wizPostalMunicipalityColumn] ?? '') : '',
      postalZip: wizPostalZipColumn ? (first[wizPostalZipColumn] ?? '') : '',
      postalProvince: wizPostalProvinceColumn ? (first[wizPostalProvinceColumn] ?? '') : '',
    }));
  }, [wizStep]);
```

Verifica i nomi esatti degli stati `wizPostalAddressColumn`/`wizPostalMunicipalityColumn`/`wizPostalZipColumn`/`wizPostalProvinceColumn` e `wizMapping` (righe ~765) prima di scrivere questo effect — sono menzionati nella spec come stati già esistenti per la mappatura colonne POSTAL, cercali con grep nel file (`grep -n "wizPostal" App.tsx`) per confermare i nomi esatti.

- [ ] **Step 3: Implementa `handleWizTestSend`**

```tsx
  const handleWizTestSend = async (): Promise<void> => {
    setWizTestError(null);
    setWizTestSubmitting(true);
    try {
      if (!wizCampaignId) throw new Error('Campagna non ancora salvata.');
      if (!wizTestForm.codiceFiscale.trim()) throw new Error('Codice Fiscale obbligatorio.');

      const first = wizValidRows[0] ?? {};
      const extraData: Record<string, string> = { ...first };
      extraData[wizMapping.codice_fiscale] = wizTestForm.codiceFiscale;
      if (wizChannelType === 'EMAIL') extraData[wizMapping.email] = wizTestForm.email;
      if (wizChannelType === 'PEC') extraData[wizMapping.pec] = wizTestForm.pec;
      if (wizChannelType === 'POSTAL') {
        if (!wizTestForm.postalAddress || !wizTestForm.postalMunicipality || !wizTestForm.postalZip || !wizTestForm.postalProvince) {
          throw new Error('Indirizzo, comune, CAP e provincia sono tutti obbligatori per il test POSTAL.');
        }
        if (wizPostalAddressColumn) extraData[wizPostalAddressColumn] = wizTestForm.postalAddress;
        if (wizPostalMunicipalityColumn) extraData[wizPostalMunicipalityColumn] = wizTestForm.postalMunicipality;
        if (wizPostalZipColumn) extraData[wizPostalZipColumn] = wizTestForm.postalZip;
        if (wizPostalProvinceColumn) extraData[wizPostalProvinceColumn] = wizTestForm.postalProvince;
      }

      const res = await fetch(`${ADMIN_API_BASE}/campaigns/${wizCampaignId}/test-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          codiceFiscale: wizTestForm.codiceFiscale,
          email: wizChannelType === 'EMAIL' ? wizTestForm.email : undefined,
          pec: wizChannelType === 'PEC' ? wizTestForm.pec : undefined,
          extraData,
        }),
      });
      const data = await res.json();
      if (data.blocked) {
        throw new Error(data.message ?? 'Invio di prova bloccato.');
      }
      if (!res.ok) {
        throw new Error(data.message ?? 'Errore durante l\'invio di prova.');
      }

      setWizTestHistory((prev) => [
        { attemptId: data.attemptId, codiceFiscale: wizTestForm.codiceFiscale, sentAt: new Date().toISOString() },
        ...prev,
      ]);
    } catch (err) {
      setWizTestError(err instanceof Error ? err.message : 'Errore durante l\'invio di prova.');
    } finally {
      setWizTestSubmitting(false);
    }
  };
```

Il campo obbligatorio per SEND/APP_IO è solo il CF (già gestito: nessun campo aggiuntivo viene richiesto/validato per quei due canali).

- [ ] **Step 4: Aggiungi il blocco JSX per lo step 7**

Subito dopo il blocco dello step 6 (Task 9), aggiungi:

```tsx
{wizStep === 7 && (
  <div className="wizard-step">
    <h3>Invio di prova</h3>
    <p>Modifica Codice Fiscale {wizChannelType === 'EMAIL' || wizChannelType === 'PEC' || wizChannelType === 'POSTAL' ? 'e destinazione' : ''} per verificare l'esito reale dell'invio prima di lanciare la campagna.</p>

    <div className="form-group">
      <label>Codice Fiscale</label>
      <input
        type="text"
        value={wizTestForm.codiceFiscale}
        onChange={(e) => setWizTestForm((prev) => ({ ...prev, codiceFiscale: e.target.value.toUpperCase() }))}
      />
    </div>

    {wizChannelType === 'EMAIL' && (
      <div className="form-group">
        <label>Email</label>
        <input type="email" value={wizTestForm.email} onChange={(e) => setWizTestForm((prev) => ({ ...prev, email: e.target.value }))} />
      </div>
    )}

    {wizChannelType === 'PEC' && (
      <div className="form-group">
        <label>PEC</label>
        <input type="email" value={wizTestForm.pec} onChange={(e) => setWizTestForm((prev) => ({ ...prev, pec: e.target.value }))} />
      </div>
    )}

    {wizChannelType === 'POSTAL' && (
      <>
        <div className="form-group">
          <label>Indirizzo</label>
          <input type="text" value={wizTestForm.postalAddress} onChange={(e) => setWizTestForm((prev) => ({ ...prev, postalAddress: e.target.value }))} />
        </div>
        <div className="form-group">
          <label>Comune</label>
          <input type="text" value={wizTestForm.postalMunicipality} onChange={(e) => setWizTestForm((prev) => ({ ...prev, postalMunicipality: e.target.value }))} />
        </div>
        <div className="form-group">
          <label>CAP</label>
          <input type="text" value={wizTestForm.postalZip} onChange={(e) => setWizTestForm((prev) => ({ ...prev, postalZip: e.target.value }))} />
        </div>
        <div className="form-group">
          <label>Provincia</label>
          <input type="text" value={wizTestForm.postalProvince} onChange={(e) => setWizTestForm((prev) => ({ ...prev, postalProvince: e.target.value }))} />
        </div>
      </>
    )}

    {wizTestError && <div className="alert alert-danger">{wizTestError}</div>}

    <div className="wizard-actions">
      <button type="button" onClick={() => setWizStep(6)} disabled={wizTestSubmitting}>Indietro</button>
      <button type="button" onClick={handleWizTestSend} disabled={wizTestSubmitting || !wizTestForm.codiceFiscale.trim()}>
        {wizTestSubmitting ? 'Invio...' : 'Invia'}
      </button>
    </div>

    {wizTestHistory.length > 0 && (
      <div className="wizard-test-history">
        <h4>Invii di prova precedenti</h4>
        <ul>
          {wizTestHistory.map((h) => (
            <li key={h.attemptId}>{h.codiceFiscale} — {new Date(h.sentAt).toLocaleString('it-IT')}</li>
          ))}
        </ul>
      </div>
    )}
  </div>
)}
```

Adatta le classi CSS (`form-group`, `wizard-step`, `wizard-actions`, `alert alert-danger`) a quelle effettivamente usate negli altri step (cercale prima di scrivere, coerenza visiva col resto del wizard).

- [ ] **Step 5: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 6: Verifica manuale nel browser**

Completa il wizard fino allo step 6 con una campagna EMAIL di test, clicca "Avvia Test", verifica che il form sia precompilato dal primo record CSV, modifica l'email a un indirizzo reale raggiungibile, clicca "Invia", verifica che arrivi effettivamente l'email e che compaia nello storico invii di prova. Ripeti la verifica anche per POSTAL (verifica indirizzo modificabile, tutti e 4 i campi obbligatori) e per SEND/APP_IO (solo CF, nessun altro campo visibile).

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): step 7 wizard - invio notifica di prova"
```

---

### Task 11: Frontend — reset/prefill wizard, allineamento nuovi stati

Coerente con il gotcha già noto in CLAUDE.md ("Terzo punto di sync, oltre ai due sopra: il lifecycle del wizard stesso") — ogni nuovo stato `wiz*` va azzerato in `resetWizard()` e considerato in `prefillWizardFrom()`.

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `resetWizard()`, `prefillWizardFrom()` (funzioni esistenti, individuate nell'esplorazione precedente).

- [ ] **Step 1: Azzera i nuovi stati in `resetWizard()`**

Trova la funzione `resetWizard()` (vicino a `handleResumeDraft`/`prefillWizardFrom`, circa righe 3846-3896) e aggiungi, tra i reset degli altri stati `wiz*`:

```tsx
    setWizTestForm({ codiceFiscale: '', email: '', pec: '', postalAddress: '', postalMunicipality: '', postalZip: '', postalProvince: '' });
    setWizTestHistory([]);
    setWizTestError(null);
```

- [ ] **Step 2: Nessun ripristino necessario in `prefillWizardFrom()`**

Lo storico invii di prova (`wizTestHistory`) è per-sessione, non persistito lato campagna madre nel `channelConfig` — riprendendo una bozza (`handleResumeDraft`) lo storico riparte vuoto, è corretto così: lo storico reale resta comunque consultabile aprendo la campagna test figlia dalla lista campagne (Task 12), `wizTestHistory` è solo una comodità di sessione nello step 7. Nessuna modifica a `prefillWizardFrom()` richiesta.

- [ ] **Step 3: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "fix(frontend-admin): azzera stati step test in resetWizard"
```

---

### Task 12: Frontend — badge "TEST" in lista campagne

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `Campaign.isTest`/`Campaign.parentCampaignId` già restituiti da `GET /admin/campaigns` (Task 2, nessun filtro applicato in `findAll()` — le campagne test compaiono già nella risposta).

- [ ] **Step 1: Individua il componente/blocco JSX che renderizza la riga di una campagna nella vista lista**

Cerca nel file la vista `'campaigns-list'` (o nome equivalente) e la porzione che mappa l'array di campagne in righe/card.

- [ ] **Step 2: Aggiungi il badge**

Nel JSX di ogni riga campagna, subito accanto al nome:

```tsx
{campaign.isTest && (
  <span className="badge bg-warning text-dark" title="Campagna di prova, collegata a una bozza">
    TEST
  </span>
)}
```

Se `campaign.parentCampaignId` è presente e si vuole un link diretto alla madre (opzionale, non bloccante per l'MVP di questo task):

```tsx
{campaign.isTest && campaign.parentCampaignId && (
  <button type="button" className="btn btn-link btn-sm" onClick={() => navigateToCampaign(campaign.parentCampaignId!)}>
    Vedi bozza madre
  </button>
)}
```

(`navigateToCampaign` è un placeholder — usa la funzione di navigazione già esistente nel componente per aprire il dettaglio di una campagna dato il suo id, cercala nel file prima di scrivere questa chiamata.)

- [ ] **Step 3: Aggiorna il tipo `Campaign` lato frontend**

Cerca l'interfaccia/tipo TypeScript `Campaign` usata nel frontend (probabilmente in `@comunicapa/shared-types` o dichiarata localmente in `App.tsx`) e aggiungi:

```ts
  isTest: boolean;
  parentCampaignId: string | null;
```

- [ ] **Step 4: Type-check**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 5: Verifica manuale**

Dopo aver eseguito un test-send (Task 10 Step 6), apri la vista lista campagne e verifica che compaia una nuova riga "[TEST] <nome campagna>" con badge visibile, e che NON venga conteggiata nei KPI aggregati della dashboard (Task 7).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): badge TEST in lista campagne per campagne isTest"
```

---

## Self-Review

**Copertura spec:** step wizard 5/6/7 (Task 8-10) ✓, salvataggio DRAFT a step4→5 (Task 8) ✓, campi editabili per canale in step7 (Task 10) ✓, modello dati isTest/parentCampaignId (Task 1-2) ✓, endpoint test-send con copia allegati+channelConfig+validazioni condivise (Task 3-4) ✓, cancellazione automatica a COMPLETED e a DELETE esplicito (Task 5-6) ✓, esclusione da KPI aggregati (Task 7) ✓, badge UI lista campagne (Task 12) ✓, lifecycle wizard reset (Task 11) ✓, visibilità lato citizen (nessuna modifica necessaria — è un invio reale sullo stesso canale, il portale cittadino non ha alcun filtro su isTest da rimuovere/aggiungere, comportamento già corretto by design).

**Rischio principale non eliminabile, solo mitigato:** Task 5 accetta esplicitamente che un job BullMQ di test ancora `QUEUED` al momento della cascata di cancellazione non venga rimosso dalla coda (nessun accesso a `NotificationQueuesService` per evitare un import circolare tra `ChannelModule` e `QueueModule`) — documentato inline nel task con la motivazione tecnica esatta.
