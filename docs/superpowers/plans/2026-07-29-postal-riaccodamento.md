# Gestione riaccodamento GlobalCom (POSTAL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando un attempt POSTAL raggiunge lo stato terminale `Eliminato`, controllare automaticamente (una tantum) o su richiesta operatore (sempre) se GlobalCom ha riaccodato il documento sotto un nuovo IDPRO, e se sì registrarlo come nuovo `NotificationAttempt` per lo stesso destinatario.

**Architecture:** Nuovo metodo `GlobalComClient.listaRiaccodamentiDocumento()` (SOAP `lista_riaccodamenti_documento`) restituisce la catena di IDPRO; `PostalStatusSyncService` la interroga quando rileva `postalStatus === 'Eliminato'` e crea un nuovo attempt (pattern `attemptNumber` già esistente in tutto il codebase) se la catena mostra un IDPRO più recente. Un flag (`postal_requeue_checked_at`) distingue il controllo automatico (una volta sola) da quello manuale (sempre, via bottone "Ricontrolla stato GlobalCom" già esistente).

**Tech Stack:** NestJS 10, TypeORM 0.3.30, node-soap, Jest.

## Global Constraints

- Riuso del pattern `attemptNumber` più alto = "ultimo tentativo del destinatario" — nessun nuovo campo di collegamento esplicito tra vecchio e nuovo attempt.
- Mai riaccodare/reinviare a mano: questo lavoro è solo lettura+registrazione di un invio già accettato da GlobalCom sotto un IDPRO diverso.
- Catena con più riaccodamenti → un solo nuovo attempt, per l'ultimo IDPRO della catena.
- Flag automatico stampato solo dopo un controllo completato con successo (trovato o non trovato) — mai su errore SOAP, per permettere retry al giro cron successivo.
- Flag manuale (`forceRequeueCheck`) ignora il flag esistente ma lo aggiorna comunque.
- Suite completa (`jest --maxWorkers=2`) va lanciata a fine piano — baseline nota: 1 solo fallimento pre-esistente (`app.controller.spec.ts`/`isLdapMock`).
- Spec di riferimento: `docs/superpowers/specs/2026-07-29-postal-riaccodamento-design.md`.

---

### Task 1: Migration + campo entity `postalRequeueCheckedAt`

**Files:**
- Create: `apps/backend/src/database/migrations/1786300000000-AddPostalRequeueCheckedAtColumn.ts`
- Modify: `apps/backend/src/database/database.module.ts` (import + array `migrations`)
- Modify: `apps/backend/src/entities/notification-attempt.entity.ts`

**Interfaces:**
- Produce: colonna `notification_attempts.postal_requeue_checked_at` (timestamptz, nullable) e campo `NotificationAttempt.postalRequeueCheckedAt: Date | null` — consumato dal Task 3.

- [ ] **Step 1: Creare il file di migration**

```ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPostalRequeueCheckedAtColumn1786300000000 implements MigrationInterface {
    name = 'AddPostalRequeueCheckedAtColumn1786300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "postal_requeue_checked_at" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "postal_requeue_checked_at"`);
    }
}
```

- [ ] **Step 2: Registrare la migration in `database.module.ts`**

Aggiungere l'import (dopo la riga con `AddCampaignConversionStatusColumns1786200000000`):

```ts
import { AddPostalRequeueCheckedAtColumn1786300000000 } from './migrations/1786300000000-AddPostalRequeueCheckedAtColumn';
```

E aggiungere `AddPostalRequeueCheckedAtColumn1786300000000` in coda all'array `migrations: [...]` (stessa riga, dopo `AddCampaignConversionStatusColumns1786200000000`).

- [ ] **Step 3: Aggiungere il campo all'entity**

In `apps/backend/src/entities/notification-attempt.entity.ts`, subito dopo il campo `postalLastCheckedAt` (righe 93-100):

```ts
  // Traccia se il controllo riaccodamento (lista_riaccodamenti_documento) è
  // già stato eseguito per questo attempt quando è arrivato a Eliminato —
  // distingue il controllo automatico (una tantum, cron) da quello manuale
  // (sempre, bottone "Ricontrolla stato"). Vedi PostalStatusSyncService e
  // docs/superpowers/specs/2026-07-29-postal-riaccodamento-design.md.
  @Column({ name: 'postal_requeue_checked_at', type: 'timestamptz', nullable: true })
  postalRequeueCheckedAt!: Date | null;
```

- [ ] **Step 4: Type-check**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 5: Verificare la migration su DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_test;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_test" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_test;"
```

Expected: tutte le migration (incluse la nuova) eseguono senza errori, la colonna `postal_requeue_checked_at` risulta creata.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/database/migrations/1786300000000-AddPostalRequeueCheckedAtColumn.ts apps/backend/src/database/database.module.ts apps/backend/src/entities/notification-attempt.entity.ts
git commit -m "feat(postal): campo postalRequeueCheckedAt per tracciare controllo riaccodamento"
```

---

### Task 2: `GlobalComClient.listaRiaccodamentiDocumento()`

**Files:**
- Modify: `apps/backend/src/channels/postal/globalcom-client.service.ts`
- Modify: `apps/backend/src/channels/postal/globalcom-client.service.spec.ts`

**Interfaces:**
- Consuma: `createSession(creds)` (privato, già esistente), stessa convenzione SOAP delle altre chiamate.
- Produce: `async listaRiaccodamentiDocumento(creds: GbcCredentials, idPro: string): Promise<string[]>` — array ordinato di IDPRO, ultimo elemento = corretto/attivo. Un documento mai riaccodato ritorna un array con un solo elemento (l'IDPRO passato). Consumato dal Task 3.

- [ ] **Step 1: Aggiungere il mock SOAP nello spec**

In `globalcom-client.service.spec.ts`, dopo la riga 6 (`const mockDettagliAsync = jest.fn();`):

```ts
const mockListaRiaccodamentiAsync = jest.fn();
```

E nel wiring `jest.mock('soap', ...)` (righe 10-20), aggiungere dentro l'oggetto ritornato da `createClientAsync`:

```ts
    lista_riaccodamenti_documentoAsync: mockListaRiaccodamentiAsync,
```

- [ ] **Step 2: Scrivere i test falliti**

Aggiungere in fondo al primo blocco `describe('GlobalComClient', ...)`, subito prima della chiusura `});` che precede `describe('mapDocStatus — campi costo', ...)`:

```ts
  it('listaRiaccodamentiDocumento ritorna solo l\'IDPRO iniziale se non ci sono riaccodamenti', async () => {
    mockListaRiaccodamentiAsync.mockResolvedValue([{
      lista_riaccodamenti_documentoResult: { string: 'IDPRO1' },
    }]);

    const result = await client.listaRiaccodamentiDocumento(creds, 'IDPRO1');

    expect(mockListaRiaccodamentiAsync).toHaveBeenCalledWith({ IDPRO: 'IDPRO1' });
    expect(result).toEqual(['IDPRO1']);
  });

  it('listaRiaccodamentiDocumento ritorna la catena completa ordinata quando ci sono riaccodamenti', async () => {
    mockListaRiaccodamentiAsync.mockResolvedValue([{
      lista_riaccodamenti_documentoResult: { string: ['IDPRO1', 'IDPRO2', 'IDPRO3'] },
    }]);

    const result = await client.listaRiaccodamentiDocumento(creds, 'IDPRO1');

    expect(result).toEqual(['IDPRO1', 'IDPRO2', 'IDPRO3']);
  });

  it('listaRiaccodamentiDocumento ritorna l\'IDPRO passato se la risposta è vuota/inattesa', async () => {
    mockListaRiaccodamentiAsync.mockResolvedValue([{
      lista_riaccodamenti_documentoResult: {},
    }]);

    const result = await client.listaRiaccodamentiDocumento(creds, 'IDPRO1');

    expect(result).toEqual(['IDPRO1']);
  });
```

- [ ] **Step 3: Eseguire i test e verificare che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest globalcom-client.service --maxWorkers=2`
Expected: FAIL — `client.listaRiaccodamentiDocumento is not a function`.

- [ ] **Step 4: Implementare il metodo**

In `globalcom-client.service.ts`, subito dopo il metodo `dettagliDocumento` (dopo la riga 338, prima del blocco commento di `informazioniUtenza`):

```ts
  /**
   * Catena di riaccodamento (manuale §2.2.57) — l'ultimo elemento è l'IDPRO
   * corretto/attivo. Se il documento non è mai stato riaccodato, la
   * risposta contiene solo l'IDPRO iniziale.
   *
   * Convenzione ASMX ArrayOfString: l'elemento ripetuto si chiama "string"
   * (stesso pattern "wrapper nominato per tipo" già verificato per
   * Destinatari/InfoIndirizzoExt e ProdottiDisponibili/ServiceType) — non
   * ancora confermato con una chiamata reale contro GlobalCom, verificare
   * al primo utilizzo in produzione (vedi
   * docs/superpowers/specs/2026-07-29-postal-riaccodamento-design.md).
   */
  async listaRiaccodamentiDocumento(creds: GbcCredentials, idPro: string): Promise<string[]> {
    const client = await this.createSession(creds);
    const [result] = await (client as any).lista_riaccodamenti_documentoAsync({ IDPRO: idPro });
    const wrapper = result.lista_riaccodamenti_documentoResult as { string?: string | string[] } | undefined;
    const raw = wrapper?.string;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [idPro];
    if (list.length === 0 || list.some((x) => typeof x !== 'string' || !x)) {
      this.logger.warn(`listaRiaccodamentiDocumento: risposta inattesa per IDPRO=${idPro} — raw: ${JSON.stringify(wrapper)}`);
      return [idPro];
    }
    return list;
  }
```

- [ ] **Step 5: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest globalcom-client.service --maxWorkers=2`
Expected: PASS, tutti i test (esistenti + nuovi).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels/postal/globalcom-client.service.ts apps/backend/src/channels/postal/globalcom-client.service.spec.ts
git commit -m "feat(postal): aggiungi GlobalComClient.listaRiaccodamentiDocumento"
```

---

### Task 3: `PostalStatusSyncService` — controllo riaccodamento su stato Eliminato

**Files:**
- Modify: `apps/backend/src/channels/postal/postal-status-sync.service.ts`
- Modify: `apps/backend/src/channels/postal/postal-status-sync.service.spec.ts`

**Interfaces:**
- Consuma: `GlobalComClient.listaRiaccodamentiDocumento(creds, idPro): Promise<string[]>` (Task 2), `GlobalComClient.dettagliDocumento(creds, idPro): Promise<GbcDocStatus | null>` (già esistente), `NotificationAttempt.postalRequeueCheckedAt` (Task 1).
- Produce: `syncOne(attempt, creds, opts?: { forceRequeueCheck?: boolean })` — firma estesa (era `syncOne(attempt, creds)`), usata sia da `handleCron` (default, `forceRequeueCheck` omesso) sia da `refreshOne` (`{ forceRequeueCheck: true }`). Nessun altro consumer esterno di `syncOne` (privato).

- [ ] **Step 1: Aggiornare il mock del repo nello spec**

In `postal-status-sync.service.spec.ts`, sostituire la dichiarazione di `attemptRepo` (riga 12 e riga 37):

Riga 12, sostituire:
```ts
  let attemptRepo: { find: jest.Mock; save: jest.Mock; createQueryBuilder: jest.Mock };
```
con:
```ts
  let attemptRepo: { find: jest.Mock; findOne: jest.Mock; findOneBy: jest.Mock; create: jest.Mock; save: jest.Mock; createQueryBuilder: jest.Mock };
```

Riga 37, sostituire:
```ts
    attemptRepo = { find: jest.fn(), save: jest.fn(), createQueryBuilder: jest.fn() };
```
con:
```ts
    attemptRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      findOneBy: jest.fn(),
      create: jest.fn((partial) => partial),
      save: jest.fn(async (entity) => entity),
      createQueryBuilder: jest.fn(),
    };
```

E nel mock `mockGlobalCom` (riga 35), aggiungere `listaRiaccodamentiDocumento: jest.fn()`:
```ts
    const mockGlobalCom = { dettagliDocumento: jest.fn(), invioExtSingolo: jest.fn(), cercaPerTesto: jest.fn(), listaRiaccodamentiDocumento: jest.fn() };
```

- [ ] **Step 2: Scrivere i test falliti**

Aggiungere in fondo al file, prima dell'ultima `});` di chiusura del `describe` principale:

```ts

  describe('controllo riaccodamento su stato Eliminato', () => {
    it('cron: rileva Eliminato senza riaccodamento — non crea nuovo attempt, stampa postalRequeueCheckedAt', async () => {
      const attempt = {
        id: 'a1', recipientId: 'r1', attemptNumber: 1,
        postalTrackingId: 'IDPRO1', postalStatus: 'Errore', postalStatusUpdatedAt: null,
        postalStatusHistory: [], postalRequeueCheckedAt: null,
      };
      attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
      globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Eliminato' } as any);
      globalCom.listaRiaccodamentiDocumento.mockResolvedValue(['IDPRO1']);

      await service.handleCron();

      expect(globalCom.listaRiaccodamentiDocumento).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: activeProvider.creds.baseUrl }),
        'IDPRO1',
      );
      expect(attemptRepo.create).not.toHaveBeenCalled();
      expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        id: 'a1', postalStatus: 'Eliminato', postalRequeueCheckedAt: expect.any(Date),
      }));
    });

    it('cron: rileva Eliminato con riaccodamento — crea nuovo attempt con l\'ultimo IDPRO della catena', async () => {
      const attempt = {
        id: 'a1', recipientId: 'r1', attemptNumber: 1,
        postalTrackingId: 'IDPRO1', postalStatus: 'Errore', postalStatusUpdatedAt: null,
        postalStatusHistory: [], postalRequeueCheckedAt: null,
      };
      attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
      globalCom.dettagliDocumento.mockImplementation(async (_creds: any, idPro: string) => {
        if (idPro === 'IDPRO1') return { idPro: 'IDPRO1', stato: 'Eliminato' } as any;
        return { idPro: 'IDPRO2', stato: 'Accettato', costoNetto: 4.31 } as any;
      });
      globalCom.listaRiaccodamentiDocumento.mockResolvedValue(['IDPRO1', 'IDPRO2']);
      attemptRepo.findOne
        .mockResolvedValueOnce(null) // idempotenza: nessun attempt esistente per IDPRO2
        .mockResolvedValueOnce({ attemptNumber: 1 }); // ultimo attempt del destinatario

      await service.handleCron();

      expect(attemptRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        recipientId: 'r1',
        channelType: 'POSTAL',
        status: 'success',
        attemptNumber: 2,
        postalTrackingId: 'IDPRO2',
        postalStatus: 'Accettato',
        costCents: 431,
      }));
      expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        postalTrackingId: 'IDPRO2', attemptNumber: 2,
      }));
      expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        id: 'a1', postalRequeueCheckedAt: expect.any(Date),
      }));
    });

    it('cron: non ripete il controllo se postalRequeueCheckedAt è già impostato', async () => {
      const attempt = {
        id: 'a1', recipientId: 'r1', attemptNumber: 1,
        postalTrackingId: 'IDPRO1', postalStatus: 'Eliminato', postalStatusUpdatedAt: null,
        postalStatusHistory: [], postalRequeueCheckedAt: new Date('2026-07-20T10:00:00.000Z'),
      };
      attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
      globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Eliminato' } as any);

      await service.handleCron();

      expect(globalCom.listaRiaccodamentiDocumento).not.toHaveBeenCalled();
    });

    it('manuale (refreshOne): ripete il controllo anche se postalRequeueCheckedAt è già impostato', async () => {
      const attempt = {
        id: 'a1', recipientId: 'r1', attemptNumber: 1, channelType: 'POSTAL',
        postalTrackingId: 'IDPRO1', postalStatus: 'Eliminato', postalStatusUpdatedAt: null,
        postalStatusHistory: [], postalRequeueCheckedAt: new Date('2026-07-20T10:00:00.000Z'),
      };
      attemptRepo.findOneBy = jest.fn().mockResolvedValue(attempt);
      globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Eliminato' } as any);
      globalCom.listaRiaccodamentiDocumento.mockResolvedValue(['IDPRO1']);

      await service.refreshOne('a1');

      expect(globalCom.listaRiaccodamentiDocumento).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: activeProvider.creds.baseUrl }),
        'IDPRO1',
      );
    });

    it('non crea un duplicato se esiste già un attempt per il nuovo IDPRO (idempotenza cron+manuale)', async () => {
      const attempt = {
        id: 'a1', recipientId: 'r1', attemptNumber: 1,
        postalTrackingId: 'IDPRO1', postalStatus: 'Eliminato', postalStatusUpdatedAt: null,
        postalStatusHistory: [], postalRequeueCheckedAt: null,
      };
      attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
      globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Eliminato' } as any);
      globalCom.listaRiaccodamentiDocumento.mockResolvedValue(['IDPRO1', 'IDPRO2']);
      attemptRepo.findOne.mockResolvedValueOnce({ id: 'a2', postalTrackingId: 'IDPRO2' });

      await service.handleCron();

      expect(attemptRepo.create).not.toHaveBeenCalled();
      expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        id: 'a1', postalRequeueCheckedAt: expect.any(Date),
      }));
    });

    it('errore SOAP nel controllo riaccodamento non blocca il salvataggio del postalStatus normale, e non stampa il flag', async () => {
      const attempt = {
        id: 'a1', recipientId: 'r1', attemptNumber: 1,
        postalTrackingId: 'IDPRO1', postalStatus: 'Errore', postalStatusUpdatedAt: null,
        postalStatusHistory: [], postalRequeueCheckedAt: null,
      };
      attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
      globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Eliminato' } as any);
      globalCom.listaRiaccodamentiDocumento.mockRejectedValue(new Error('timeout SOAP'));

      await service.handleCron();

      expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        id: 'a1', postalStatus: 'Eliminato',
      }));
      const savedCalls = attemptRepo.save.mock.calls.map((c: any[]) => c[0]);
      expect(savedCalls.some((s: any) => s.id === 'a1' && s.postalRequeueCheckedAt != null)).toBe(false);
    });
  });
```

- [ ] **Step 3: Eseguire i test e verificare che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest postal-status-sync.service --maxWorkers=2`
Expected: FAIL — `globalCom.listaRiaccodamentiDocumento` mai chiamato / `attemptRepo.create` non esiste come atteso nel service.

- [ ] **Step 4: Implementare `checkRequeue` e wiring in `syncOne`/`refreshOne`**

In `postal-status-sync.service.ts`, sostituire l'intero metodo `syncOne` (righe 64-115) con:

```ts
  private async syncOne(attempt: NotificationAttempt, creds: GbcCredentials, opts: { forceRequeueCheck?: boolean } = {}): Promise<boolean> {
    const stato = await this.globalCom.dettagliDocumento(creds, attempt.postalTrackingId!);
    attempt.postalLastCheckedAt = new Date();
    if (!stato) {
      await this.attemptRepo.save(attempt);
      return false;
    }

    let changed = false;
    if (stato.stato !== attempt.postalStatus) {
      attempt.postalStatus = stato.stato;
      attempt.postalStatusUpdatedAt = new Date();
      attempt.postalStatusHistory = [
        ...(attempt.postalStatusHistory ?? []),
        {
          stato: stato.stato,
          rilevatoIl: new Date().toISOString(),
          ...(stato.codiceErrore && stato.codiceErrore !== '0' ? { codiceErrore: stato.codiceErrore } : {}),
          ...(stato.descrizione && stato.codiceErrore !== '0' ? { descrizione: stato.descrizione } : {}),
        },
      ];
      changed = true;
    }
    if (attempt.costCents === null && stato.costoNetto !== null && stato.costoNetto !== undefined) {
      attempt.costCents = Math.round(stato.costoNetto * 100);
      attempt.costCalculatedAt = new Date();
      attempt.costBreakdown = {
        costoNetto: stato.costoNetto,
        numeroPagine: stato.numeroPagine ?? null,
        nazionale: stato.nazionale ?? null,
        importoPostaleNetto: stato.importoPostaleNetto ?? null,
        importoStampaNetto: stato.importoStampaNetto ?? null,
        importoARNetto: stato.importoARNetto ?? null,
        tipoDocumento: stato.tipoDocumento ?? null,
        codiceContratto: stato.codiceContratto ?? null,
      };
      changed = true;
    }

    if (attempt.postalStatus === 'Eliminato' && (opts.forceRequeueCheck || !attempt.postalRequeueCheckedAt)) {
      await this.checkRequeue(attempt, creds);
    }

    await this.attemptRepo.save(attempt);
    return changed;
  }

  /**
   * Un attempt Eliminato può essere stato riaccodato da GlobalCom sotto un
   * nuovo IDPRO (mai un re-invio nostro — solo presa d'atto di un invio già
   * accettato). `lista_riaccodamenti_documento` ritorna l'intera catena,
   * l'ultimo elemento è quello corretto/attivo. Se la catena ha più di un
   * riaccodamento si crea un solo nuovo attempt per l'ultimo IDPRO — gli
   * intermedi non hanno valore proprio. Il flag `postalRequeueCheckedAt`
   * viene stampato solo se il controllo è andato a buon fine (trovato o
   * non trovato) — su errore SOAP resta invariato, il prossimo giro cron
   * riprova (il chiamante manuale invece forza sempre il controllo, vedi
   * `refreshOne`).
   */
  private async checkRequeue(attempt: NotificationAttempt, creds: GbcCredentials): Promise<void> {
    try {
      const chain = await this.globalCom.listaRiaccodamentiDocumento(creds, attempt.postalTrackingId!);
      const nuovoIdPro = chain[chain.length - 1];
      if (chain.length > 1 && nuovoIdPro && nuovoIdPro !== attempt.postalTrackingId) {
        const esistente = await this.attemptRepo.findOne({ where: { recipientId: attempt.recipientId, postalTrackingId: nuovoIdPro } });
        if (!esistente) {
          const statoNuovo = await this.globalCom.dettagliDocumento(creds, nuovoIdPro);
          const ultimoAttempt = await this.attemptRepo.findOne({ where: { recipientId: attempt.recipientId }, order: { attemptNumber: 'DESC' } });
          const nextAttemptNumber = (ultimoAttempt?.attemptNumber ?? attempt.attemptNumber) + 1;
          const nuovoAttempt = this.attemptRepo.create({
            recipientId: attempt.recipientId,
            channelType: attempt.channelType,
            status: AttemptStatus.SUCCESS,
            attemptNumber: nextAttemptNumber,
            sentAt: new Date(),
            postalTrackingId: nuovoIdPro,
            postalStatus: statoNuovo?.stato ?? null,
            postalStatusUpdatedAt: statoNuovo ? new Date() : null,
            postalStatusHistory: statoNuovo ? [{ stato: statoNuovo.stato, rilevatoIl: new Date().toISOString() }] : null,
            costCents: statoNuovo?.costoNetto != null ? Math.round(statoNuovo.costoNetto * 100) : null,
            costCalculatedAt: statoNuovo?.costoNetto != null ? new Date() : null,
            costBreakdown: statoNuovo?.costoNetto != null ? {
              costoNetto: statoNuovo.costoNetto,
              numeroPagine: statoNuovo.numeroPagine ?? null,
              nazionale: statoNuovo.nazionale ?? null,
              importoPostaleNetto: statoNuovo.importoPostaleNetto ?? null,
              importoStampaNetto: statoNuovo.importoStampaNetto ?? null,
              importoARNetto: statoNuovo.importoARNetto ?? null,
              tipoDocumento: statoNuovo.tipoDocumento ?? null,
              codiceContratto: statoNuovo.codiceContratto ?? null,
            } : null,
          });
          await this.attemptRepo.save(nuovoAttempt);
          this.logger.log(`Riaccodamento rilevato: attempt ${attempt.id} IDPRO ${attempt.postalTrackingId} -> ${nuovoIdPro}, creato nuovo attempt attemptNumber=${nextAttemptNumber}`);
        }
      }
      attempt.postalRequeueCheckedAt = new Date();
    } catch (err: any) {
      this.logger.warn(`Errore controllo riaccodamento per attempt ${attempt.id} (IDPRO=${attempt.postalTrackingId}): ${err.message}`);
    }
  }
```

E sostituire, nel metodo `refreshOne` (riga 138), la riga:
```ts
    const changed = await this.syncOne(attempt, provider.creds);
```
con:
```ts
    const changed = await this.syncOne(attempt, provider.creds, { forceRequeueCheck: true });
```

- [ ] **Step 5: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest postal-status-sync.service --maxWorkers=2`
Expected: PASS, tutti i test (esistenti + nuovi).

- [ ] **Step 6: Type-check**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/channels/postal/postal-status-sync.service.ts apps/backend/src/channels/postal/postal-status-sync.service.spec.ts
git commit -m "feat(postal): rileva riaccodamento GlobalCom su stato Eliminato, crea nuovo attempt"
```

---

### Task 4: Verifica suite completa e chiusura

**Files:** nessuna modifica — solo verifica.

- [ ] **Step 1: Suite completa**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure set della baseline nota (solo `app.controller.spec.ts`/`isLdapMock`), nessuna nuova regressione.

- [ ] **Step 2: Verifica manuale UI (nessuna modifica frontend prevista)**

Aprire il dettaglio di una notifica POSTAL con un attempt Eliminato in ambiente dev (`LDAP_HOST=mock`), forzare via DB un secondo `NotificationAttempt` con `attemptNumber` più alto per lo stesso `recipientId` (simula il riaccodamento) e confermare che la tabella "Storico Tentativi" nel modale "Dettaglio Notifica" lo mostra automaticamente, senza bisogno di modifiche al frontend — conferma l'assunzione del design doc (sezione "Fuori scope").

- [ ] **Step 3: Nessun commit da questo task** — solo verifica, il codice è già committato nei Task 1-3.
