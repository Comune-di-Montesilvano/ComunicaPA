# Costo Notifiche Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tracciare il costo reale delle notifiche SEND e POSTAL (leggendo dati reali già esposti dalle rispettive API, nessun tariffario manuale) e mostrare costo totale + risparmio da dirottamento INAD/App IO in dettaglio campagna, dashboard e statistiche.

**Architecture:** Nuove colonne su `NotificationAttempt` (`cost_cents`, `cost_calculated_at`, `cost_breakdown`) popolate dai demoni di sync stato esistenti (`send-status-sync.service.ts`, `postal-status-sync.service.ts`), che oggi scaricano già i dati sorgente ma li scartano. Nuovi metodi di aggregazione in `campaigns.service.ts` seguono il pattern già esistente (`getSendStatusBreakdown`/`getGlobalStats`). EMAIL/PEC/APP_IO restano implicitamente a costo zero.

**Tech Stack:** NestJS 10 + TypeORM (backend), React 19 + Recharts (frontend-admin), Jest per i test.

## Global Constraints

- Spec di riferimento: `docs/superpowers/specs/2026-07-21-costo-notifiche-design.md`.
- Nessun backfill su notifiche storiche — solo attempt sincronizzati da ora in poi.
- Nessun tariffario manuale per POSTAL: il costo reale arriva da `Valori.Costo` nella risposta SOAP `dettagli_documento`, già verificato dal vivo (2026-07-21).
- Nessuna stima di risparmio per destinatari POSTAL dirottati (mostrata N/D, esclusa dal totale).
- Notifiche senza `cost_cents` calcolato sono escluse silenziosamente dai totali — nessun contatore "N/D" in UI.
- Ogni test backend va eseguito con `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` (mai senza, satura la RAM su WSL2).
- Dopo ogni modifica a `src/backend`, hot-reload NestJS spesso non vede i cambi su bind mount Windows: verificare `dist/` più recente di `src/` o fare `docker compose restart backend`.

---

### Task 1: Migration — nuove colonne costo su `notification_attempts`

**Files:**
- Create: `apps/backend/src/database/migrations/1785100000000-AddCostColumns.ts`
- Modify: `apps/backend/src/database/database.module.ts:38` (import), `:52` (array `migrations`)
- Modify: `apps/backend/src/entities/notification-attempt.entity.ts:91` (nuove colonne)

**Interfaces:**
- Produces: `NotificationAttempt.costCents: number | null`, `NotificationAttempt.costCalculatedAt: Date | null`, `NotificationAttempt.costBreakdown: Record<string, unknown> | null` — usati da tutti i task successivi (2, 4, 6, 7, 8).

- [ ] **Step 1: Creare la migration**

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCostColumns1785100000000 implements MigrationInterface {
    name = 'AddCostColumns1785100000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "cost_cents" integer`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "cost_calculated_at" TIMESTAMP WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" ADD "cost_breakdown" jsonb`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "cost_breakdown"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "cost_calculated_at"`);
        await queryRunner.query(`ALTER TABLE "notification_attempts" DROP COLUMN "cost_cents"`);
    }
}
```

- [ ] **Step 2: Registrare la migration in `database.module.ts`**

Aggiungere l'import dopo la riga 38:
```typescript
import { AddCostColumns1785100000000 } from './migrations/1785100000000-AddCostColumns';
```

Aggiungere `AddCostColumns1785100000000` in coda all'array `migrations` (riga 52), dopo `AddTestCampaignColumns1785000000000`.

- [ ] **Step 3: Aggiungere le colonne all'entity**

In `apps/backend/src/entities/notification-attempt.entity.ts`, subito dopo il campo `postalStatusHistory` (prima di `errorMessage`):

```typescript
  @Column({ type: 'int', name: 'cost_cents', nullable: true })
  costCents!: number | null;

  @Column({ name: 'cost_calculated_at', type: 'timestamptz', nullable: true })
  costCalculatedAt!: Date | null;

  @Column({ type: 'jsonb', name: 'cost_breakdown', nullable: true })
  costBreakdown!: Record<string, unknown> | null;
```

- [ ] **Step 4: Verificare la migration su DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_gen;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_gen" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
```

Expected: output elenca `AddCostColumns1785100000000` tra le migration eseguite, nessun errore.

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_gen;"
```

- [ ] **Step 5: Type-check backend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Expected: nessun errore.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/database/migrations/1785100000000-AddCostColumns.ts apps/backend/src/database/database.module.ts apps/backend/src/entities/notification-attempt.entity.ts
git commit -m "feat(backend): aggiungi colonne costo a NotificationAttempt"
```

---

### Task 2: Settings — `send.digitalBaseFeeCents`

**Files:**
- Modify: `apps/backend/src/settings/settings.registry.ts:59` (dopo `send.enabledTaxonomyCodes`)

**Interfaces:**
- Produces: chiave settings `'send.digitalBaseFeeCents'` (type `number`, default `0`), leggibile via `AppSettingsService.get<number>('send.digitalBaseFeeCents')` — usata da Task 6.

- [ ] **Step 1: Aggiungere la chiave**

In `apps/backend/src/settings/settings.registry.ts`, subito dopo la riga:
```typescript
  'send.enabledTaxonomyCodes': { type: 'string', default: '[]' },
```
aggiungere:
```typescript
  // Costo base "gestione piattaforma" per ogni notifica SEND digitale
  // (~1€ nel contratto tipo, vedi gara nazionale PN) — fallback quando
  // GET price/{paTaxId}/{noticeCode} non è disponibile (nessun notice
  // pagoPA associato alla notifica, o chiamata fallita). Vedi
  // docs/superpowers/specs/2026-07-21-costo-notifiche-design.md.
  'send.digitalBaseFeeCents': { type: 'number', default: 0 },
```

- [ ] **Step 2: Type-check backend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Expected: nessun errore.

- [ ] **Step 3: Verificare che la chiave sia esposta da `GET admin/settings`**

```bash
docker compose exec backend node -e "const jwt=require('/app/node_modules/.pnpm/node_modules/jsonwebtoken');console.log(jwt.sign({sub:'debug',username:'debug',role:'admin',type:'operator'},process.env.JWT_SECRET,{expiresIn:'10m'}))"
```

Copiare il token stampato, poi:
```bash
docker compose exec backend sh -c "curl -s -H 'Authorization: Bearer <TOKEN>' http://localhost:8080/admin/settings | grep digitalBaseFeeCents"
```

Expected: la chiave `send.digitalBaseFeeCents` compare nella risposta con valore `0`.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/settings/settings.registry.ts
git commit -m "feat(backend): aggiungi setting send.digitalBaseFeeCents"
```

---

### Task 3: POSTAL — estendere `GbcDocStatus`/`mapDocStatus` con i campi costo

**Files:**
- Modify: `apps/backend/src/channels/postal/globalcom-client.service.ts:42-84`
- Test: `apps/backend/src/channels/postal/globalcom-client.service.spec.ts`

**Interfaces:**
- Consumes: nessuno (modifica isolata al parsing).
- Produces: `GbcDocStatus` esteso con `costoNetto: number | null`, `numeroPagine: number | null`, `nazionale: boolean | null`, `importoPostaleNetto: number | null`, `importoStampaNetto: number | null`, `importoARNetto: number | null`, `tipoDocumento: string | null`, `codiceContratto: string | null` — usato da Task 4.

- [ ] **Step 1: Scrivere il test che fallisce**

Aggiungere a `apps/backend/src/channels/postal/globalcom-client.service.spec.ts` (nello stesso file, dentro il blocco che testa `dettagliDocumento` — se non esiste un blocco `describe('dettagliDocumento'`, aggiungerlo):

```typescript
describe('mapDocStatus — campi costo', () => {
  it('estrae Costo/NumeroPagine/Nazionale/DettaglioBilling dalla risposta Risposta.Valori', () => {
    const raw = {
      IDPRO: 'SOA_123',
      Stato: 'Confermato',
      CodiceErrore: '0',
      Descrizione: '',
      TipoDocumento: 'RaccomandataMarket4',
      CodiceContratto: '40009679559',
      Nazionale: true,
      Valori: {
        Costo: 4.31,
        NumeroPagine: 2,
        DettaglioBilling: {
          ImportoPostaleNetto: 4.03,
          ImportoStampaNetto: 0.28,
          ImportoARNetto: 0,
        },
      },
    };

    const result = mapDocStatus(raw);

    expect(result.costoNetto).toBe(4.31);
    expect(result.numeroPagine).toBe(2);
    expect(result.nazionale).toBe(true);
    expect(result.importoPostaleNetto).toBe(4.03);
    expect(result.importoStampaNetto).toBe(0.28);
    expect(result.importoARNetto).toBe(0);
    expect(result.tipoDocumento).toBe('RaccomandataMarket4');
    expect(result.codiceContratto).toBe('40009679559');
  });

  it('gestisce Valori assente (risposta di errore) senza lanciare', () => {
    const raw = { IDPRO: 'SOA_123', Stato: 'Errore', CodiceErrore: '99', Descrizione: 'fallito' };

    const result = mapDocStatus(raw);

    expect(result.costoNetto).toBeNull();
    expect(result.numeroPagine).toBeNull();
    expect(result.nazionale).toBeNull();
  });
});
```

`mapDocStatus` non è esportata oggi — aggiungere `export` davanti alla dichiarazione della funzione in `globalcom-client.service.ts:77` e importarla nel test:
```typescript
import { mapDocStatus } from './globalcom-client.service';
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

```bash
docker compose exec backend node_modules/.bin/jest globalcom-client.service.spec --maxWorkers=2
```

Expected: FAIL — `result.costoNetto` è `undefined`, non `4.31`.

- [ ] **Step 3: Implementare l'estrazione**

In `apps/backend/src/channels/postal/globalcom-client.service.ts`, sostituire l'interfaccia e la funzione:

```typescript
export interface GbcDocStatus {
  idPro: string;
  stato: string;
  codiceErrore?: string;
  descrizione?: string;
  /** Costo netto reale in euro (Risposta.Valori.Costo) — null se Valori assente (es. risposta di errore). */
  costoNetto: number | null;
  numeroPagine: number | null;
  /** true = invio nazionale, false = estero (Risposta.Nazionale). */
  nazionale: boolean | null;
  importoPostaleNetto: number | null;
  importoStampaNetto: number | null;
  importoARNetto: number | null;
  tipoDocumento: string | null;
  codiceContratto: string | null;
}
```

```typescript
export function mapDocStatus(raw: any): GbcDocStatus {
  const valori = raw.Valori;
  const billing = valori?.DettaglioBilling;
  return {
    idPro: raw.IDPRO,
    stato: raw.Stato,
    codiceErrore: raw.CodiceErrore,
    descrizione: raw.Descrizione,
    costoNetto: valori?.Costo ?? null,
    numeroPagine: valori?.NumeroPagine ?? null,
    nazionale: raw.Nazionale ?? null,
    importoPostaleNetto: billing?.ImportoPostaleNetto ?? null,
    importoStampaNetto: billing?.ImportoStampaNetto ?? null,
    importoARNetto: billing?.ImportoARNetto ?? null,
    tipoDocumento: raw.TipoDocumento ?? null,
    codiceContratto: raw.CodiceContratto ?? null,
  };
}
```

- [ ] **Step 4: Eseguire il test e verificare che passi**

```bash
docker compose exec backend node_modules/.bin/jest globalcom-client.service.spec --maxWorkers=2
```

Expected: PASS.

- [ ] **Step 5: Type-check backend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Expected: nessun errore (verificare che nessun altro chiamante di `mapDocStatus`/`GbcDocStatus` si rompa per i nuovi campi obbligatori non-opzionali).

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels/postal/globalcom-client.service.ts apps/backend/src/channels/postal/globalcom-client.service.spec.ts
git commit -m "feat(backend): estrai campi costo reali da risposta GlobalCom dettagli_documento"
```

---

### Task 4: POSTAL — calcolare e salvare `cost_cents` in `postal-status-sync.service.ts`

**Files:**
- Modify: `apps/backend/src/channels/postal/postal-status-sync.service.ts`
- Test: `apps/backend/src/channels/postal/postal-status-sync.service.spec.ts`

**Interfaces:**
- Consumes: `GbcDocStatus.costoNetto`/`numeroPagine`/`nazionale`/`importoPostaleNetto`/`importoStampaNetto`/`importoARNetto`/`tipoDocumento`/`codiceContratto` (Task 3), `NotificationAttempt.costCents`/`costCalculatedAt`/`costBreakdown` (Task 1).
- Produces: nessuno consumato da altri task (i dati sono letti da Task 9 tramite query diretta su `NotificationAttempt`).

**Vincolo di design importante**: il `Costo` GlobalCom può comparire/stabilizzarsi anche quando lo stato di consegna (`Stato`) non cambia più tra un poll e l'altro (es. resta `Confermato` mentre il costo era già presente al primo poll, o si aggiorna più tardi senza un cambio di `Stato` visibile). La query del cron oggi esclude gli attempt con `postal_status` già in `TERMINAL_STATUSES` — se un attempt raggiunge lo stato terminale prima che il costo sia mai stato letto (improbabile ma non impossibile), resterebbe escluso per sempre. Per sicurezza, la query va estesa per includere anche gli attempt terminali con `cost_cents IS NULL`.

- [ ] **Step 1: Scrivere il test che fallisce — salva costo quando `Costo` è presente**

Aggiungere a `apps/backend/src/channels/postal/postal-status-sync.service.spec.ts`:

```typescript
  it('salva cost_cents e cost_breakdown quando dettagliDocumento ritorna Costo', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Confermato', postalStatusUpdatedAt: null, postalStatusHistory: null, costCents: null };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({
      idPro: 'IDPRO1',
      stato: 'Confermato',
      costoNetto: 4.31,
      numeroPagine: 2,
      nazionale: true,
      importoPostaleNetto: 4.03,
      importoStampaNetto: 0.28,
      importoARNetto: 0,
      tipoDocumento: 'RaccomandataMarket4',
      codiceContratto: '40009679559',
    });

    await service.handleCron();

    expect(attemptRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'a1',
      costCents: 431,
      costCalculatedAt: expect.any(Date),
      costBreakdown: {
        costoNetto: 4.31,
        numeroPagine: 2,
        nazionale: true,
        importoPostaleNetto: 4.03,
        importoStampaNetto: 0.28,
        importoARNetto: 0,
        tipoDocumento: 'RaccomandataMarket4',
        codiceContratto: '40009679559',
      },
    }));
  });

  it('include nella query gli attempt già terminali ma senza costo ancora calcolato', async () => {
    const qb = makeQueryBuilder([]);
    attemptRepo.createQueryBuilder.mockReturnValue(qb);

    await service.handleCron();

    const includesCostNull = qb.andWhere.mock.calls.some(([sql]: [string]) => /cost_cents/i.test(sql));
    expect(includesCostNull).toBe(true);
  });

  it('non ricalcola il costo se cost_cents è già valorizzato e lo stato non cambia', async () => {
    const attempt = { id: 'a1', postalTrackingId: 'IDPRO1', postalStatus: 'Confermato', postalStatusUpdatedAt: null, costCents: 431 };
    attemptRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    globalCom.dettagliDocumento.mockResolvedValue({ idPro: 'IDPRO1', stato: 'Confermato', costoNetto: 4.31 });

    await service.handleCron();

    expect(attemptRepo.save).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Eseguire i test e verificare che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest postal-status-sync.service.spec --maxWorkers=2
```

Expected: FAIL sui primi due nuovi test (il terzo passa già, comportamento invariato).

- [ ] **Step 3: Implementare**

Sostituire il contenuto di `postal-status-sync.service.ts` con:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { NotificationAttempt, AttemptStatus } from '../../entities/notification-attempt.entity';
import { PostalProvidersService } from '../../postal-providers/postal-providers.service';
import { GlobalComClient } from './globalcom-client.service';

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
 *
 * Legge anche il costo reale (Valori.Costo) dalla stessa risposta
 * dettagli_documento — un attempt resta candidato al poll anche a stato
 * terminale finché cost_cents non è stato calcolato almeno una volta (vedi
 * docs/superpowers/specs/2026-07-21-costo-notifiche-design.md).
 */
@Injectable()
export class PostalStatusSyncService {
  private readonly logger = new Logger(PostalStatusSyncService.name);

  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    private readonly providers: PostalProvidersService,
    private readonly globalCom: GlobalComClient,
  ) {}

  @Cron('*/5 * * * *')
  async handleCron(): Promise<void> {
    const attempts = await this.attemptRepo
      .createQueryBuilder('attempt')
      .where('attempt.channel_type = :ch', { ch: 'POSTAL' })
      .andWhere('attempt.status = :status', { status: AttemptStatus.SUCCESS })
      .andWhere('attempt.postal_tracking_id IS NOT NULL')
      .andWhere('((attempt.postal_status IS NULL OR attempt.postal_status NOT IN (:...terminal)) OR attempt.cost_cents IS NULL)', { terminal: TERMINAL_STATUSES })
      .orderBy('attempt.created_at', 'ASC')
      .take(BATCH_SIZE)
      .getMany();

    if (attempts.length === 0) return;

    const provider = await this.providers.getActive();
    if (!provider) return;
    const creds = provider.creds;

    for (const attempt of attempts) {
      try {
        const stato = await this.globalCom.dettagliDocumento(creds, attempt.postalTrackingId!);
        if (!stato) continue;

        let changed = false;
        if (stato.stato !== attempt.postalStatus) {
          attempt.postalStatus = stato.stato;
          attempt.postalStatusUpdatedAt = new Date();
          attempt.postalStatusHistory = [
            ...(attempt.postalStatusHistory ?? []),
            { stato: stato.stato, rilevatoIl: new Date().toISOString() },
          ];
          changed = true;
        }
        if (attempt.costCents === null && stato.costoNetto !== null) {
          attempt.costCents = Math.round(stato.costoNetto * 100);
          attempt.costCalculatedAt = new Date();
          attempt.costBreakdown = {
            costoNetto: stato.costoNetto,
            numeroPagine: stato.numeroPagine,
            nazionale: stato.nazionale,
            importoPostaleNetto: stato.importoPostaleNetto,
            importoStampaNetto: stato.importoStampaNetto,
            importoARNetto: stato.importoARNetto,
            tipoDocumento: stato.tipoDocumento,
            codiceContratto: stato.codiceContratto,
          };
          changed = true;
        }
        if (changed) await this.attemptRepo.save(attempt);
      } catch (err: any) {
        this.logger.warn(`Errore aggiornamento stato POSTAL per attempt ${attempt.id} (IDPRO=${attempt.postalTrackingId}): ${err.message}`);
      }
    }
  }
}
```

- [ ] **Step 4: Eseguire i test e verificare che passino**

```bash
docker compose exec backend node_modules/.bin/jest postal-status-sync.service.spec --maxWorkers=2
```

Expected: PASS su tutti i test del file, incluso quelli pre-esistenti (nessuna regressione — verificare in particolare `'non salva se lo stato non è cambiato'`: con `costCents` già valorizzato nel fixture di quel test resta `save` non chiamato).

- [ ] **Step 5: Type-check backend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels/postal/postal-status-sync.service.ts apps/backend/src/channels/postal/postal-status-sync.service.spec.ts
git commit -m "feat(backend): calcola e salva costo reale POSTAL da GlobalCom"
```

---

### Task 5: SEND — estrarre `analogCost` dalla timeline PN

**Files:**
- Modify: `apps/backend/src/channels/send/send-status-history.util.ts`
- Test: `apps/backend/src/channels/send/send-status-history.util.spec.ts` (creare se non esiste — verificare prima con `Glob`)

**Interfaces:**
- Produces: `extractSendAnalogCost(data: unknown): SendAnalogCostInfo` dove `SendAnalogCostInfo = { analogCostCents: number; events: Array<{ productType: string | null; analogCostCents: number; envelopeWeight: number | null; numberOfPages: number | null }> }` — usata da Task 7.

- [ ] **Step 1: Verificare se esiste già un file di test per `send-status-history.util.ts`**

```bash
docker compose exec backend sh -c "test -f apps/backend/src/channels/send/send-status-history.util.spec.ts && echo ESISTE || echo NON-ESISTE"
```

Se `NON-ESISTE`, crearlo con l'header minimo:
```typescript
import { extractSendStatusHistory, extractSendDigitalDomicile, extractSendAnalogCost } from './send-status-history.util';
```

- [ ] **Step 2: Scrivere il test che fallisce**

```typescript
describe('extractSendAnalogCost', () => {
  it('somma analogCost di tutti gli eventi SEND_ANALOG_DOMICILE con dettagli SendAnalogDetails', () => {
    const data = {
      timeline: [
        { category: 'SEND_DIGITAL_DOMICILE', details: { digitalAddress: { type: 'PEC', address: 'x@pec.it' } } },
        { category: 'SEND_ANALOG_DOMICILE', details: { productType: 'AR', analogCost: 970, envelopeWeight: 20, numberOfPages: 2 } },
      ],
    };

    const result = extractSendAnalogCost(data);

    expect(result.analogCostCents).toBe(970);
    expect(result.events).toEqual([{ productType: 'AR', analogCostCents: 970, envelopeWeight: 20, numberOfPages: 2 }]);
  });

  it('somma più eventi analogici sullo stesso IUN (es. rispedizione dopo tentativo fallito)', () => {
    const data = {
      timeline: [
        { category: 'SEND_ANALOG_DOMICILE', details: { productType: 'RS', analogCost: 400, envelopeWeight: 10, numberOfPages: 1 } },
        { category: 'SEND_SIMPLE_REGISTERED_LETTER', details: { productType: 'RS', analogCost: 450, envelopeWeight: 10, numberOfPages: 1 } },
      ],
    };

    const result = extractSendAnalogCost(data);

    expect(result.analogCostCents).toBe(850);
    expect(result.events).toHaveLength(2);
  });

  it('ritorna 0/array vuoto se nessun evento analogico è presente (notifica rimasta digitale)', () => {
    const data = { timeline: [{ category: 'SEND_DIGITAL_DOMICILE', details: { digitalAddress: { type: 'PEC', address: 'x@pec.it' } } }] };

    const result = extractSendAnalogCost(data);

    expect(result.analogCostCents).toBe(0);
    expect(result.events).toEqual([]);
  });

  it('gestisce timeline assente senza lanciare', () => {
    const result = extractSendAnalogCost({});

    expect(result.analogCostCents).toBe(0);
    expect(result.events).toEqual([]);
  });
});
```

- [ ] **Step 3: Eseguire il test e verificare che fallisca**

```bash
docker compose exec backend node_modules/.bin/jest send-status-history.util.spec --maxWorkers=2
```

Expected: FAIL — `extractSendAnalogCost` non è una funzione esportata.

- [ ] **Step 4: Implementare**

Aggiungere in coda a `send-status-history.util.ts`:

```typescript
export interface SendAnalogCostEvent {
  productType: string | null;
  analogCostCents: number;
  envelopeWeight: number | null;
  numberOfPages: number | null;
}

export interface SendAnalogCostInfo {
  analogCostCents: number;
  events: SendAnalogCostEvent[];
}

const ANALOG_CATEGORIES_WITH_COST = ['SEND_ANALOG_DOMICILE', 'SEND_SIMPLE_REGISTERED_LETTER'];

/**
 * Somma analogCost (già in eurocent, campo reale PN) su TUTTI gli eventi
 * analogici della timeline di un IUN — un IUN può avere più eventi (es.
 * primo tentativo fallito + rispedizione), ognuno con un costo reale
 * proprio. Vedi docs/superpowers/specs/2026-07-21-costo-notifiche-design.md.
 */
export function extractSendAnalogCost(data: unknown): SendAnalogCostInfo {
  const timeline = (data as { timeline?: unknown })?.timeline;
  if (!Array.isArray(timeline)) return { analogCostCents: 0, events: [] };

  const events: SendAnalogCostEvent[] = [];
  for (const el of timeline as any[]) {
    if (ANALOG_CATEGORIES_WITH_COST.includes(el?.category) && typeof el?.details?.analogCost === 'number') {
      events.push({
        productType: el.details.productType ?? null,
        analogCostCents: el.details.analogCost,
        envelopeWeight: el.details.envelopeWeight ?? null,
        numberOfPages: el.details.numberOfPages ?? null,
      });
    }
  }

  return { analogCostCents: events.reduce((sum, e) => sum + e.analogCostCents, 0), events };
}
```

- [ ] **Step 5: Eseguire il test e verificare che passi**

```bash
docker compose exec backend node_modules/.bin/jest send-status-history.util.spec --maxWorkers=2
```

Expected: PASS.

- [ ] **Step 6: Type-check backend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/channels/send/send-status-history.util.ts apps/backend/src/channels/send/send-status-history.util.spec.ts
git commit -m "feat(backend): estrai costo analogico reale dalla timeline SEND"
```

---

### Task 6: SEND — risoluzione base fee (price endpoint con fallback costante)

**Files:**
- Create: `apps/backend/src/channels/send/send-base-fee.service.ts`
- Test: `apps/backend/src/channels/send/send-base-fee.service.spec.ts`
- Modify: `apps/backend/src/channels/send/send.module.ts` (o il modulo che dichiara `SendStatusSyncService` — verificare nome esatto con `Glob apps/backend/src/channels/send/*.module.ts` prima di modificare)

**Interfaces:**
- Consumes: `AppSettingsService.get<number>('send.digitalBaseFeeCents')` (Task 2), header/env pattern uguale a `SendStatusSyncService.getEnvAndBaseUrl()`.
- Produces: `SendBaseFeeService.resolve(envKey: 'test' | 'prod', baseUrl: string, apiKey: string, voucher: string, paTaxId: string | null, noticeCode: string | null): Promise<number>` (ritorna sempre centesimi, mai lancia) — usato da Task 7.

- [ ] **Step 1: Verificare il nome del modulo SEND esistente**

```bash
docker compose exec backend sh -c "ls apps/backend/src/channels/send/*.module.ts 2>/dev/null || echo NESSUN-MODULO-DEDICATO"
```

Se `NESSUN-MODULO-DEDICATO`, cercare dove `SendStatusSyncService` è registrato come provider (`grep -rn "SendStatusSyncService" apps/backend/src --include=*.module.ts`) e usare lo stesso modulo per il nuovo service.

- [ ] **Step 2: Scrivere il test che fallisce**

```typescript
import { Test } from '@nestjs/testing';
import { SendBaseFeeService } from './send-base-fee.service';
import { AppSettingsService } from '../../settings/app-settings.service';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe('SendBaseFeeService', () => {
  let service: SendBaseFeeService;
  const mockSettings = { get: jest.fn(async () => 100) };

  beforeEach(async () => {
    mockFetch.mockClear();
    const module = await Test.createTestingModule({
      providers: [SendBaseFeeService, { provide: AppSettingsService, useValue: mockSettings }],
    }).compile();
    service = module.get(SendBaseFeeService);
  });

  it('usa sendFee reale da PN se paTaxId e noticeCode sono disponibili e la chiamata riesce', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ sendFee: 150 })),
    });

    const result = await service.resolve('test', 'https://send.test', 'apikey', 'voucher', '01234567890', 'NOTICE123');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery/v2.3/price/01234567890/NOTICE123',
      expect.objectContaining({ headers: { 'x-api-key': 'apikey', Authorization: 'Bearer voucher' } }),
    );
    expect(result).toBe(150);
  });

  it('usa il fallback configurato se noticeCode è null', async () => {
    const result = await service.resolve('test', 'https://send.test', 'apikey', 'voucher', null, null);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result).toBe(100);
  });

  it('usa il fallback configurato se la chiamata price fallisce', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('not found') });

    const result = await service.resolve('test', 'https://send.test', 'apikey', 'voucher', '01234567890', 'NOTICE123');

    expect(result).toBe(100);
  });
});
```

- [ ] **Step 3: Eseguire il test e verificare che fallisca**

```bash
docker compose exec backend node_modules/.bin/jest send-base-fee.service.spec --maxWorkers=2
```

Expected: FAIL — modulo non trovato.

- [ ] **Step 4: Implementare**

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { AppSettingsService } from '../../settings/app-settings.service';

/**
 * Costo digitale base ("gestione piattaforma", ~1€ nel contratto tipo
 * PN): GET price/{paTaxId}/{noticeCode} lo espone SOLO se la notifica ha
 * un notice pagoPA associato — non sempre il caso. Fallback su
 * send.digitalBaseFeeCents quando il notice manca o la chiamata fallisce.
 * Vedi docs/superpowers/specs/2026-07-21-costo-notifiche-design.md.
 */
@Injectable()
export class SendBaseFeeService {
  private readonly logger = new Logger(SendBaseFeeService.name);

  constructor(private readonly settings: AppSettingsService) {}

  async resolve(
    envKey: 'test' | 'prod',
    baseUrl: string,
    apiKey: string,
    voucher: string,
    paTaxId: string | null,
    noticeCode: string | null,
  ): Promise<number> {
    const fallback = await this.settings.get<number>('send.digitalBaseFeeCents');

    if (!paTaxId || !noticeCode) return fallback;

    try {
      const res = await fetch(`${baseUrl}/delivery/v2.3/price/${paTaxId}/${noticeCode}`, {
        headers: { 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
      });
      if (!res.ok) {
        this.logger.warn(`price endpoint fallito per paTaxId=${paTaxId} noticeCode=${noticeCode}: HTTP ${res.status}`);
        return fallback;
      }
      const data = (await res.json()) as { sendFee?: number };
      return typeof data.sendFee === 'number' ? data.sendFee : fallback;
    } catch (err: any) {
      this.logger.warn(`Errore chiamata price endpoint: ${err.message}`);
      return fallback;
    }
  }
}
```

- [ ] **Step 5: Registrare il provider nel modulo SEND**

Aggiungere `SendBaseFeeService` all'array `providers` del modulo individuato allo Step 1 (accanto a `SendStatusSyncService`), con relativo import.

- [ ] **Step 6: Eseguire il test e verificare che passi**

```bash
docker compose exec backend node_modules/.bin/jest send-base-fee.service.spec --maxWorkers=2
```

Expected: PASS.

- [ ] **Step 7: Type-check backend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/channels/send/send-base-fee.service.ts apps/backend/src/channels/send/send-base-fee.service.spec.ts apps/backend/src/channels/send/*.module.ts
git commit -m "feat(backend): risolvi costo base digitale SEND da PN con fallback configurabile"
```

---

### Task 7: SEND — wiring calcolo costo in `send-status-sync.service.ts`

**Files:**
- Modify: `apps/backend/src/channels/send/send-status-sync.service.ts`
- Test: `apps/backend/src/channels/send/send-status-sync.service.spec.ts`

**Interfaces:**
- Consumes: `extractSendAnalogCost` (Task 5), `SendBaseFeeService.resolve` (Task 6), `NotificationAttempt.costCents`/`costCalculatedAt`/`costBreakdown` (Task 1).

**Vincolo di design**: stesso problema di Task 4 — `updateStatuses()` oggi salva solo se `notificationStatus` cambia rispetto a `attempt.sendStatus`; un attempt che raggiunge subito uno stato terminale nello stesso poll in cui viene creato non verrebbe mai ripescato per calcolare il costo in un poll successivo. La query va estesa con la stessa condizione `OR cost_cents IS NULL` usata in Task 4, e il salvataggio va reso indipendente dal cambio di stato.

Su `paTaxId`/`noticeCode`: nella base di codice attuale non esiste un campo esplicito che leghi un `Recipient`/`NotificationAttempt` a un notice pagoPA (verificato in fase di brainstorming — nessun campo dedicato). Per questo task, passare sempre `null, null` a `SendBaseFeeService.resolve` (quindi userà sempre il fallback configurato) — se in futuro viene aggiunto un campo notice, questo è l'unico punto da toccare.

- [ ] **Step 1: Scrivere il test che fallisce**

Aggiungere a `apps/backend/src/channels/send/send-status-sync.service.spec.ts`:

```typescript
  it('updateStatuses: calcola e salva cost_cents (base fee + analogico) da timeline PN', async () => {
    const attempt: any = { id: 'a1', iun: 'IUN-123', sendStatus: 'ACCEPTED', costCents: null };
    const qb = makeQueryBuilder([attempt]);
    mockRepo.createQueryBuilder.mockReturnValue(qb);
    mockFetch.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({
        notificationStatus: 'DELIVERED',
        notificationStatusHistory: [{ status: 'DELIVERED', activeFrom: '2026-01-12T09:00:00Z' }],
        timeline: [
          { category: 'SEND_ANALOG_DOMICILE', details: { productType: 'AR', analogCost: 970, envelopeWeight: 20, numberOfPages: 2 } },
        ],
      })),
    });

    await service.updateStatuses();

    expect(attempt.costCents).toBe(1070); // 100 (fallback base fee mockato) + 970
    expect(attempt.costBreakdown).toEqual({
      baseFeeCents: 100,
      analogEvents: [{ productType: 'AR', analogCostCents: 970, envelopeWeight: 20, numberOfPages: 2 }],
    });
    expect(mockRepo.save).toHaveBeenCalledWith(attempt);
  });

  it('updateStatuses: include nella query gli attempt terminali senza costo ancora calcolato', async () => {
    const qb = makeQueryBuilder([]);
    mockRepo.createQueryBuilder.mockReturnValue(qb);

    await service.updateStatuses();

    const includesCostNull = qb.andWhere.mock.calls.some(([sql]: [string]) => /cost_cents/i.test(sql));
    expect(includesCostNull).toBe(true);
  });

  it('updateStatuses: non ricalcola il costo se già presente e lo stato non cambia', async () => {
    const attempt: any = { id: 'a1', iun: 'IUN-123', sendStatus: 'DELIVERED', costCents: 1070 };
    mockRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([attempt]));
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve(JSON.stringify({ notificationStatus: 'DELIVERED' })) });

    await service.updateStatuses();

    expect(mockRepo.save).not.toHaveBeenCalled();
  });
```

Aggiungere anche il mock del nuovo provider nel `beforeEach` esistente:
```typescript
const mockSendBaseFee = { resolve: jest.fn(async () => 100) };
```
e nell'array `providers` di `Test.createTestingModule`:
```typescript
{ provide: SendBaseFeeService, useValue: mockSendBaseFee },
```
con il relativo import in cima al file:
```typescript
import { SendBaseFeeService } from './send-base-fee.service';
```

- [ ] **Step 2: Eseguire i test e verificare che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest send-status-sync.service.spec --maxWorkers=2
```

Expected: FAIL sui tre nuovi test; il costruttore del service non accetta ancora `SendBaseFeeService`.

- [ ] **Step 3: Implementare**

Modificare `send-status-sync.service.ts`:

```typescript
import { extractSendStatusHistory, extractSendDigitalDomicile, extractSendAnalogCost } from './send-status-history.util';
import { SendBaseFeeService } from './send-base-fee.service';
```

Nel costruttore, aggiungere il nuovo parametro:
```typescript
  constructor(
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    private readonly settings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
    private readonly baseFee: SendBaseFeeService,
  ) {}
```

Modificare `updateStatuses()`:

```typescript
  async updateStatuses(): Promise<void> {
    const { envKey, baseUrl, apiKey, purposeId } = await this.getEnvAndBaseUrl();
    const attempts = await this.attemptRepo
      .createQueryBuilder('attempt')
      .where('attempt.channel_type = :ch', { ch: 'SEND' })
      .andWhere('attempt.iun IS NOT NULL')
      .andWhere('((attempt.send_status IS NULL OR attempt.send_status NOT IN (:...terminal)) OR attempt.cost_cents IS NULL)', { terminal: TERMINAL_STATUSES })
      .orderBy('attempt.created_at', 'ASC')
      .take(BATCH_SIZE)
      .getMany();

    if (attempts.length === 0) return;
    const voucher = await this.pdndAuth.getVoucher(envKey, purposeId);

    for (const attempt of attempts) {
      try {
        const res = await fetch(`${baseUrl}/delivery/v2.9/notifications/sent/${attempt.iun}`, {
          headers: { 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
        });
        const text = await res.text();
        if (!res.ok) {
          this.logger.warn(`Aggiornamento stato SEND IUN ${attempt.iun} fallito: HTTP ${res.status} — ${text.slice(0, 300)}`);
          continue;
        }
        const data = JSON.parse(text) as { notificationStatus: string };

        let changed = false;
        if (data.notificationStatus && data.notificationStatus !== attempt.sendStatus) {
          attempt.sendStatus = data.notificationStatus;
          attempt.sendStatusUpdatedAt = new Date();
          attempt.sendStatusHistory = extractSendStatusHistory(data);
          attempt.sendDigitalDomicile = extractSendDigitalDomicile(data);
          changed = true;
        }

        if (attempt.costCents === null) {
          const analog = extractSendAnalogCost(data);
          // paTaxId/noticeCode: nessun campo dedicato in Recipient/NotificationAttempt
          // oggi — sempre null, quindi baseFee usa sempre il fallback configurato
          // (vedi send-base-fee.service.ts).
          const baseFeeCents = await this.baseFee.resolve(envKey, baseUrl, apiKey, voucher, null, null);
          attempt.costCents = baseFeeCents + analog.analogCostCents;
          attempt.costCalculatedAt = new Date();
          attempt.costBreakdown = { baseFeeCents, analogEvents: analog.events };
          changed = true;
        }

        if (changed) await this.attemptRepo.save(attempt);
      } catch (err: any) {
        this.logger.warn(`Errore aggiornamento stato SEND IUN ${attempt.iun}: ${err.message}`);
      }
    }
  }
```

- [ ] **Step 4: Eseguire i test e verificare che passino**

```bash
docker compose exec backend node_modules/.bin/jest send-status-sync.service.spec --maxWorkers=2
```

Expected: PASS su tutti i test del file, inclusi i pre-esistenti (in particolare `'updateStatuses: non salva se lo stato non è cambiato'` — verificare che nel suo fixture `attempt.costCents` sia già non-null, altrimenti quel test andrebbe aggiornato per riflettere che ora un attempt con `costCents: null` viene comunque salvato anche a stato invariato; se necessario aggiornare il fixture di quel test esistente aggiungendo `costCents: 999` per isolare il comportamento che testa).

- [ ] **Step 5: Type-check backend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

- [ ] **Step 6: Eseguire l'intera suite backend (audit costruttore — vedi CLAUDE.md)**

```bash
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

Expected: stesso failure set noto pre-esistente (1 fallimento `app.controller.spec.ts` `isLdapMock`), nessuna nuova regressione — il costruttore di `SendStatusSyncService` è cambiato, verificare che nessun altro file istanzi il service manualmente con `new SendStatusSyncService(...)` senza il nuovo parametro.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/channels/send/send-status-sync.service.ts apps/backend/src/channels/send/send-status-sync.service.spec.ts
git commit -m "feat(backend): calcola e salva costo reale SEND (base fee + analogico)"
```

---

### Task 8: DTO backend — `CampaignCostDto`, `CampaignCostSavingsDto`, estensione `GlobalStatsDto`

**Files:**
- Modify: `apps/backend/src/campaigns/dto/campaign-stats.dto.ts` (aggiungere in coda)
- Modify: `apps/backend/src/campaigns/dto/global-stats.dto.ts`

**Interfaces:**
- Produces: `CampaignCostDto`, `CampaignCostSavingsDto`, `GlobalStatsDto.totals.totalCostCents`, `GlobalStatsDto.totals.totalSavingCents` — usati da Task 9 e 10.

- [ ] **Step 1: Aggiungere i DTO campagna**

In coda a `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`:

```typescript
export interface CampaignCostChannelDto {
  channel: 'SEND' | 'POSTAL';
  totalCostCents: number;
  /** Numero di attempt di questo canale con costo ancora non calcolato — esclusi da totalCostCents. */
  uncalculatedCount: number;
}

export interface CampaignCostDto {
  campaignId: string;
  totalCostCents: number;
  byChannel: CampaignCostChannelDto[];
}

export interface CampaignCostSavingsDto {
  campaignId: string;
  /** Somma dei risparmi calcolabili (solo destinatari SEND dirottati/skippati) — vedi design doc per il perché POSTAL non è incluso. */
  totalSavingCents: number;
  /** Numero di destinatari POSTAL dirottati per cui il risparmio non è stimabile (mostrato N/D in UI). */
  postalNotEstimableCount: number;
}
```

- [ ] **Step 2: Estendere `GlobalStatsDto`**

In `apps/backend/src/campaigns/dto/global-stats.dto.ts`, modificare `GlobalStatsTotalsDto`:

```typescript
export interface GlobalStatsTotalsDto {
  totalRecipients: number;
  totalSent: number;
  totalFailed: number;
  totalDownloaded: number;
  downloadPercentage: number;
  totalCostCents: number;
  totalSavingCents: number;
}
```

- [ ] **Step 3: Type-check backend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Expected: errore atteso in `campaigns.service.ts` (`getGlobalStats` non popola ancora i nuovi campi obbligatori) — è normale, verrà risolto nel Task 10. Annotare l'errore e procedere.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/campaigns/dto/campaign-stats.dto.ts apps/backend/src/campaigns/dto/global-stats.dto.ts
git commit -m "feat(backend): DTO costo/risparmio campagna e statistiche globali"
```

---

### Task 9: `campaigns.service.ts` — `getCampaignCost` e `getCampaignCostSavings`

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts` (verificare nome esatto con `Glob` prima di editare — se il file supera una soglia gestibile, aggiungere i test in un nuovo file dedicato `campaigns.service.cost.spec.ts` nello stesso pattern di test già usato per gli altri metodi di breakdown, per non gonfiare ulteriormente un file già molto grande)

**Interfaces:**
- Consumes: `CampaignCostDto`, `CampaignCostSavingsDto` (Task 8), `NotificationAttempt.costCents` (Task 1), `Recipient.inadCheck` (esistente).
- Produces: `CampaignsService.getCampaignCost(campaignId: string): Promise<CampaignCostDto>`, `CampaignsService.getCampaignCostSavings(campaignId: string): Promise<CampaignCostSavingsDto>` — usati da Task 11.

- [ ] **Step 1: Individuare il file di test corretto**

```bash
docker compose exec backend sh -c "ls apps/backend/src/campaigns/campaigns.service*.spec.ts"
```

Usare il file esistente più piccolo/dedicato se ce n'è uno per i metodi di breakdown (cercare `getSendStatusBreakdown` con grep dentro i file trovati); altrimenti creare `apps/backend/src/campaigns/campaigns.service.cost.spec.ts` seguendo l'header/setup del file che testa `getSendStatusBreakdown` (stesso `TestingModule`, stessi mock repository).

- [ ] **Step 2: Scrivere i test che falliscono**

```typescript
describe('getCampaignCost', () => {
  it('somma costCents degli attempt SEND/POSTAL della campagna per canale, escludendo quelli senza costo calcolato', async () => {
    campaignRepo.findOneBy.mockResolvedValue({ id: 'c1' });
    recipientRepo.find.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
    attemptRepo.find.mockResolvedValue([
      { recipientId: 'r1', channelType: 'SEND', costCents: 100 },
      { recipientId: 'r2', channelType: 'SEND', costCents: null },
      { recipientId: 'r3', channelType: 'POSTAL', costCents: 431 },
    ]);

    const result = await service.getCampaignCost('c1');

    expect(result.totalCostCents).toBe(531);
    expect(result.byChannel).toEqual(expect.arrayContaining([
      { channel: 'SEND', totalCostCents: 100, uncalculatedCount: 1 },
      { channel: 'POSTAL', totalCostCents: 431, uncalculatedCount: 0 },
    ]));
  });

  it('lancia NotFoundException se la campagna non esiste', async () => {
    campaignRepo.findOneBy.mockResolvedValue(null);

    await expect(service.getCampaignCost('missing')).rejects.toThrow(NotFoundException);
  });
});

describe('getCampaignCostSavings', () => {
  it('calcola risparmio SEND solo per destinatari dirottati/senza attempt a pagamento (fallback base fee)', async () => {
    campaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'SEND' });
    recipientRepo.find.mockResolvedValue([
      { id: 'r1', inadCheck: null },
      { id: 'r2', inadCheck: { diverted: true } },
    ]);
    attemptRepo.find.mockResolvedValue([
      { recipientId: 'r1', channelType: 'SEND', costCents: 100 },
      // r2: nessun attempt SEND (dirottato/skippato) → costo reale incorso 0
    ]);
    settingsService.get.mockResolvedValue(100); // send.digitalBaseFeeCents

    const result = await service.getCampaignCostSavings('c1');

    expect(result.totalSavingCents).toBe(100); // solo r2: 100 (nominale) - 0 (reale)
    expect(result.postalNotEstimableCount).toBe(0);
  });

  it('campagna POSTAL: nessun risparmio stimato, solo conteggio dirottati N/D', async () => {
    campaignRepo.findOneBy.mockResolvedValue({ id: 'c1', channelType: 'POSTAL' });
    recipientRepo.find.mockResolvedValue([{ id: 'r1', inadCheck: { diverted: true } }]);

    const result = await service.getCampaignCostSavings('c1');

    expect(result.totalSavingCents).toBe(0);
    expect(result.postalNotEstimableCount).toBe(1);
  });
});
```

Nota: adattare i nomi dei mock (`campaignRepo`, `recipientRepo`, `attemptRepo`, `settingsService`) a quelli effettivamente usati nel file di test scelto allo Step 1 — potrebbero avere nomi diversi (es. `mockCampaignRepo`).

- [ ] **Step 3: Eseguire i test e verificare che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service.cost --maxWorkers=2
```

(o il pattern corrispondente al file scelto)

Expected: FAIL — metodi non esistenti.

- [ ] **Step 4: Implementare `getCampaignCost`**

Aggiungere in `campaigns.service.ts`, subito dopo `getPostalStatusBreakdown` (segue esattamente lo stesso pattern: `findOneBy` → 404 → `recipientRepo.find` per gli id → `attemptRepo.find` con `select` mirato):

```typescript
  async getCampaignCost(campaignId: string): Promise<CampaignCostDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const recipientIds = (await this.recipientRepo.find({ where: { campaignId }, select: ['id'] })).map((r) => r.id);
    if (recipientIds.length === 0) return { campaignId, totalCostCents: 0, byChannel: [] };

    const attempts = await this.attemptRepo.find({
      where: { recipientId: In(recipientIds), channelType: In(['SEND', 'POSTAL']) },
      select: ['recipientId', 'channelType', 'costCents'],
    });

    const byChannelMap = new Map<string, { totalCostCents: number; uncalculatedCount: number }>();
    for (const a of attempts) {
      const entry = byChannelMap.get(a.channelType) ?? { totalCostCents: 0, uncalculatedCount: 0 };
      if (a.costCents === null) entry.uncalculatedCount += 1;
      else entry.totalCostCents += a.costCents;
      byChannelMap.set(a.channelType, entry);
    }

    const byChannel = Array.from(byChannelMap.entries()).map(([channel, v]) => ({
      channel: channel as 'SEND' | 'POSTAL',
      totalCostCents: v.totalCostCents,
      uncalculatedCount: v.uncalculatedCount,
    }));

    return {
      campaignId,
      totalCostCents: byChannel.reduce((sum, c) => sum + c.totalCostCents, 0),
      byChannel,
    };
  }
```

- [ ] **Step 5: Implementare `getCampaignCostSavings`**

Aggiungere subito dopo `getCampaignCost`:

```typescript
  async getCampaignCostSavings(campaignId: string): Promise<CampaignCostSavingsDto> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    // Nessuna stima di risparmio per POSTAL: il costo dipende da pagine/
    // tipologia effettive, non stimabile per un invio mai avvenuto (vedi
    // docs/superpowers/specs/2026-07-21-costo-notifiche-design.md).
    if (campaign.channelType === 'POSTAL') {
      const diverted = await this.recipientRepo.count({ where: { campaignId, inadCheck: Raw((alias) => `${alias}->>'diverted' = 'true'`) } });
      return { campaignId, totalSavingCents: 0, postalNotEstimableCount: diverted };
    }

    if (campaign.channelType !== 'SEND') {
      return { campaignId, totalSavingCents: 0, postalNotEstimableCount: 0 };
    }

    const recipients = await this.recipientRepo.find({ where: { campaignId }, select: ['id'] });
    const recipientIds = recipients.map((r) => r.id);
    if (recipientIds.length === 0) return { campaignId, totalSavingCents: 0, postalNotEstimableCount: 0 };

    const attempts = await this.attemptRepo.find({
      where: { recipientId: In(recipientIds), channelType: 'SEND' },
      select: ['recipientId', 'costCents'],
    });
    const costByRecipient = new Map<string, number>();
    for (const a of attempts) {
      costByRecipient.set(a.recipientId, (costByRecipient.get(a.recipientId) ?? 0) + (a.costCents ?? 0));
    }

    const nominalBaseFeeCents = await this.settings.get<number>('send.digitalBaseFeeCents');
    let totalSavingCents = 0;
    for (const id of recipientIds) {
      const actual = costByRecipient.get(id) ?? 0;
      const saving = nominalBaseFeeCents - actual;
      if (saving > 0) totalSavingCents += saving;
    }

    return { campaignId, totalSavingCents, postalNotEstimableCount: 0 };
  }
```

Verificare che `this.settings` (istanza di `AppSettingsService`) sia già iniettata nel costruttore di `CampaignsService` — se non lo è, aggiungerla seguendo il pattern degli altri servizi iniettati nello stesso costruttore, e ricordare l'audit dei costruttori del Task 7 Step 6 (nuovi parametri rompono spec che istanziano il service a mano).

- [ ] **Step 6: Eseguire i test e verificare che passino**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service.cost --maxWorkers=2
```

Expected: PASS.

- [ ] **Step 7: Type-check backend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

- [ ] **Step 8: Eseguire l'intera suite backend**

```bash
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

Expected: stesso failure set noto (1 fallimento `isLdapMock`), nessuna regressione nuova.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.cost.spec.ts
git commit -m "feat(backend): aggregazione costo e risparmio per campagna"
```

---

### Task 10: `campaigns.service.ts` — estendere `getGlobalStats` con costo/risparmio aggregato

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts:1151-1258` (`getGlobalStats`)
- Test: stesso file di test del Task 9 (o quello dedicato a `getGlobalStats` — verificare con grep)

**Interfaces:**
- Consumes: `GlobalStatsDto.totals.totalCostCents`/`totalSavingCents` (Task 8).
- Produces: `getGlobalStats()` ora popola questi due campi — usato da Task 11 (nessuna modifica endpoint necessaria, la route esiste già).

- [ ] **Step 1: Scrivere il test che fallisce**

Individuare/creare il test per `getGlobalStats` (`grep -rn "getGlobalStats" apps/backend/src/campaigns/*.spec.ts`) e aggiungere:

```typescript
  it('getGlobalStats: include totalCostCents e totalSavingCents aggregati su tutte le campagne SEND/POSTAL nel range', async () => {
    // Adattare il setup del queryBuilder mock allo stile già usato dagli altri
    // sub-test di getGlobalStats in questo file (range date, isTest=false).
    attemptRepo.createQueryBuilder.mockReturnValue({
      innerJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ totalCostCents: '2431' }),
    });

    const result = await service.getGlobalStats();

    expect(result.totals.totalCostCents).toBe(2431);
  });
```

Nota: questo test è indicativo — il valore esatto del mock dipende da come si implementa la query (Step 2). Aggiornarlo per farlo combaciare con l'implementazione reale prima di considerarlo la verifica finale, non limitarsi a farlo passare artificialmente.

- [ ] **Step 2: Implementare la query di aggregazione costo**

In `getGlobalStats()`, dopo il blocco `neverDownloadedCount` (riga 1231) e prima del blocco `totalRecipients`/`totalSent`/`totalFailed` (riga 1233), aggiungere:

```typescript
    const costRow = await this.attemptRepo
      .createQueryBuilder('a')
      .innerJoin('a.recipient', 'r')
      .innerJoin('r.campaign', 'c')
      .select('COALESCE(SUM(a.costCents), 0)', 'totalCostCents')
      .where('a.channelType IN (:...channels)', { channels: ['SEND', 'POSTAL'] })
      .andWhere('a.costCents IS NOT NULL')
      .andWhere(range.sql, range.params)
      .andWhere('c.isTest = false')
      .getRawOne<{ totalCostCents: string }>();

    const savingRow = await this.recipientRepo
      .createQueryBuilder('r')
      .innerJoin('r.campaign', 'c')
      .leftJoin('r.attempts', 'a', "a.channel_type = 'SEND'")
      .select('c.id', 'campaignId')
      .addSelect('COALESCE(SUM(a.costCents), 0)', 'actualCostCents')
      .addSelect('COUNT(DISTINCT r.id)', 'recipientCount')
      .where("c.channelType = 'SEND'")
      .andWhere(range.sql, range.params)
      .andWhere('c.isTest = false')
      .groupBy('c.id')
      .getRawMany<{ campaignId: string; actualCostCents: string; recipientCount: string }>();

    const nominalBaseFeeCents = await this.settings.get<number>('send.digitalBaseFeeCents');
    // Approssimazione: nominale = baseFee × n.destinatari − costo reale
    // aggregato per campagna, solo se positivo. Coerente con la formula
    // per-destinatario di getCampaignCostSavings, ma qui aggregata per non
    // dover iterare ogni destinatario di ogni campagna SEND nel range —
    // accettabile perché il fallback base fee è costante per destinatario.
    const totalSavingCents = savingRow.reduce((sum, row) => {
      const nominal = nominalBaseFeeCents * Number(row.recipientCount);
      const saving = nominal - Number(row.actualCostCents);
      return saving > 0 ? sum + saving : sum;
    }, 0);
```

Modificare il `return` finale aggiungendo i due campi dentro `totals`:

```typescript
      totals: {
        totalRecipients,
        totalSent,
        totalFailed,
        totalDownloaded,
        downloadPercentage: computeDownloadPercentage(totalDownloaded, totalRecipients),
        totalCostCents: Number(costRow?.totalCostCents ?? 0),
        totalSavingCents,
      },
```

Verificare che `this.settings` (Task 9) sia già disponibile nel costruttore; verificare anche che la relazione `Recipient.attempts` esista già (usata altrove, vedi `notification-attempt.entity.ts:101` `@ManyToOne('Recipient', 'attempts', ...)`).

- [ ] **Step 3: Eseguire il test e verificare che passi**

```bash
docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2 -t "getGlobalStats"
```

Expected: PASS (aggiustare il mock del Step 1 se la query reale usa una forma diversa da quella indicativa).

- [ ] **Step 4: Type-check backend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Expected: nessun errore — i campi obbligatori di `GlobalStatsTotalsDto` (Task 8) sono ora tutti popolati.

- [ ] **Step 5: Eseguire l'intera suite backend**

```bash
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

Expected: stesso failure set noto, nessuna regressione.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/*.spec.ts
git commit -m "feat(backend): includi costo e risparmio aggregati in getGlobalStats"
```

---

### Task 11: `campaigns.controller.ts` — endpoint HTTP costo campagna

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts` (dopo l'endpoint `postal-status-breakdown`, righe 655-658)

**Interfaces:**
- Consumes: `CampaignsService.getCampaignCost`, `CampaignsService.getCampaignCostSavings` (Task 9).
- Produces: `GET /admin/campaigns/:id/cost` → `CampaignCostDto`, `GET /admin/campaigns/:id/cost-savings` → `CampaignCostSavingsDto` — usati da Task 12 (frontend).

- [ ] **Step 1: Aggiungere gli endpoint**

Subito dopo il blocco esistente:
```typescript
  @Get(':id/postal-status-breakdown')
  getPostalStatusBreakdown(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getPostalStatusBreakdown(id);
  }
```
aggiungere:
```typescript
  @Get(':id/cost')
  getCampaignCost(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getCampaignCost(id);
  }

  @Get(':id/cost-savings')
  getCampaignCostSavings(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getCampaignCostSavings(id);
  }
```

- [ ] **Step 2: Type-check backend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

- [ ] **Step 3: Verifica manuale end-to-end**

```bash
docker compose restart backend
```

Attendere l'avvio, poi (sostituendo `<TOKEN>` col token debug generato come in Task 2 Step 3, e `<CAMPAIGN_ID>` con un id di campagna SEND o POSTAL reale in DB):
```bash
docker compose exec backend sh -c "curl -s -H 'Authorization: Bearer <TOKEN>' http://localhost:8080/admin/campaigns/<CAMPAIGN_ID>/cost"
docker compose exec backend sh -c "curl -s -H 'Authorization: Bearer <TOKEN>' http://localhost:8080/admin/campaigns/<CAMPAIGN_ID>/cost-savings"
```

Expected: entrambe rispondono 200 con JSON conforme a `CampaignCostDto`/`CampaignCostSavingsDto` (usare la campagna `TEST REALE GlobalCom 2 - RaccomandataMarket4`, id `36ad1728-c57c-4c93-920c-d908ad2bb6b4`, verificata dal vivo in fase di design — dopo che Task 4 ha girato almeno un ciclo di cron su di essa, `totalCostCents` deve valere `431`).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.controller.ts
git commit -m "feat(backend): esponi endpoint costo e risparmio campagna"
```

---

### Task 12: Frontend — costo/risparmio nel dettaglio campagna

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `GET ${ADMIN_API_BASE}/campaigns/:id/cost` → `{ campaignId, totalCostCents, byChannel: [{channel, totalCostCents, uncalculatedCount}] }`, `GET .../cost-savings` → `{ campaignId, totalSavingCents, postalNotEstimableCount }` (Task 11).

- [ ] **Step 1: Aggiungere gli state**

Vicino a `sendStatusBreakdown`/`postalStatusBreakdown` (circa riga 1433-1434):
```typescript
const [campaignCost, setCampaignCost] = useState<{ campaignId: string; totalCostCents: number; byChannel: Array<{ channel: string; totalCostCents: number; uncalculatedCount: number }> } | null>(null);
const [campaignCostSavings, setCampaignCostSavings] = useState<{ campaignId: string; totalSavingCents: number; postalNotEstimableCount: number } | null>(null);
```

- [ ] **Step 2: Aggiungere le funzioni fetch**

Vicino a `fetchPostalStatusBreakdown` (circa riga 4920), stesso pattern esatto:
```typescript
const fetchCampaignCost = async (id: string) => {
  try {
    const res = await apiFetch(`/campaigns/${id}/cost`);
    if (!res.ok) return;
    setCampaignCost(await res.json());
  } catch {
    // Non bloccante: il dettaglio campagna resta usabile senza il costo.
  }
};

const fetchCampaignCostSavings = async (id: string) => {
  try {
    const res = await apiFetch(`/campaigns/${id}/cost-savings`);
    if (!res.ok) return;
    setCampaignCostSavings(await res.json());
  } catch {
    // Non bloccante: il dettaglio campagna resta usabile senza il risparmio.
  }
};
```

- [ ] **Step 3: Wire in `handleCampaignClick` e nel polling**

In `handleCampaignClick` (circa riga 4820), aggiungere i reset e i trigger:
```typescript
  setCampaignCost(null);
  setCampaignCostSavings(null);
  // ... (tra i reset esistenti, prima delle chiamate fetch)
  fetchCampaignCost(id);
  fetchCampaignCostSavings(id);
```

Nel `useEffect` di polling del dettaglio campagna (circa riga 1452-1474), aggiungere dentro il blocco `setInterval`:
```typescript
        fetchCampaignCost(selectedCampaignId);
        fetchCampaignCostSavings(selectedCampaignId);
```

- [ ] **Step 4: Renderizzare il blocco costo**

Accanto al blocco render del grafico "Canale Effettivo" (circa riga 10865-10894, stesso pattern di card), aggiungere una nuova card, condizionata a `campaign?.channelType === 'SEND' || campaign?.channelType === 'POSTAL'` (nessun costo per gli altri canali):

```jsx
{campaign && (campaign.channelType === 'SEND' || campaign.channelType === 'POSTAL') && campaignCost && (
<div className="col-md-6">
  <div className="card shadow-sm h-100">
    <div className="card-header bg-white py-3 border-bottom">
      <h3 className="h6 mb-0 fw-bold text-dark"><Euro className="me-2 text-primary" size={16} />Costo Campagna</h3>
    </div>
    <div className="card-body">
      <div className="text-center mb-3">
        <span className="text-muted small d-block">Costo Totale</span>
        <h3 className="h2 mb-0 fw-bold text-primary">{(campaignCost.totalCostCents / 100).toFixed(2)} €</h3>
      </div>
      {campaignCost.byChannel.map((c) => (
        <div key={c.channel} className="d-flex justify-content-between small mb-1">
          <span>{c.channel}</span>
          <span>
            {(c.totalCostCents / 100).toFixed(2)} €
            {c.uncalculatedCount > 0 && <span className="text-muted ms-1">({c.uncalculatedCount} non calcolati)</span>}
          </span>
        </div>
      ))}
      {campaignCostSavings && campaignCostSavings.totalSavingCents > 0 && (
        <div className="alert alert-success small mt-3 mb-0">
          Risparmio stimato da dirottamento: <strong>{(campaignCostSavings.totalSavingCents / 100).toFixed(2)} €</strong>
        </div>
      )}
      {campaignCostSavings && campaignCostSavings.postalNotEstimableCount > 0 && (
        <p className="text-muted small mt-2 mb-0">
          {campaignCostSavings.postalNotEstimableCount} destinatari POSTAL dirottati — risparmio non stimabile (N/D).
        </p>
      )}
    </div>
  </div>
</div>
)}
```

Verificare che l'icona `Euro` sia già importata da `lucide-react` in cima al file (`grep -n "^import.*lucide-react" apps/frontend-admin/src/App.tsx` e cercare `Euro` nell'elenco importato) — se assente, aggiungerla all'import esistente.

- [ ] **Step 4bis: Verifica manuale in browser**

```bash
docker compose logs frontend-admin --since 1m 2>&1 | tail -20
```

Aprire `http://localhost:3000`, login admin/admin (dev con `LDAP_HOST=mock`), navigare al dettaglio della campagna `TEST REALE GlobalCom 2 - RaccomandataMarket4`. Expected: card "Costo Campagna" visibile con `4,31 €` (dato reale verificato in fase di design), nessun errore in console.

- [ ] **Step 5: Type-check frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): mostra costo e risparmio nel dettaglio campagna"
```

---

### Task 13: Frontend — widget costo in Dashboard e Statistiche

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `globalStats.totals.totalCostCents`/`totalSavingCents` (estensione del tipo esistente, dati da Task 10 via endpoint già esistente `GET /campaigns/stats/global`).

- [ ] **Step 1: Estendere il tipo `globalStats`**

Nello `useState<...>` di `globalStats` (circa riga 1440), aggiungere i due campi dentro `totals`:
```typescript
const [globalStats, setGlobalStats] = useState<{
  totals: { totalRecipients: number; totalSent: number; totalFailed: number; totalDownloaded: number; downloadPercentage: number; totalCostCents: number; totalSavingCents: number };
  monthlyTrend: Array<{ month: string; sent: number; downloaded: number }>;
  channelTotals: Array<{ channel: string; sent: number }>;
  downloadChannelTotals: Array<{ channel: string; count: number }>;
  campaignLeaderboard: Array<{ campaignId: string; campaignName: string; totalRecipients: number; downloadPercentage: number }>;
  neverDownloadedCount: number;
} | null>(null);
```

- [ ] **Step 2: Estendere il trigger di `fetchGlobalStats` a `view === 'dashboard'`**

Modificare lo `useEffect` di ingresso vista (circa riga 993-998):
```typescript
useEffect(() => {
  if ((view === 'statistiche' || view === 'dashboard') && token) {
    fetchGlobalStats();
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [view, token]);
```

E il polling (circa riga 1489-1498):
```typescript
useEffect(() => {
  if (!token || (view !== 'statistiche' && view !== 'dashboard')) return;
  const timer = setInterval(() => {
    fetchGlobalStats();
  }, 5000);
  return () => clearInterval(timer);
}, [token, view]);
```

- [ ] **Step 3: Aggiungere la card costo in Dashboard**

Nel blocco `view === 'dashboard'` (circa riga 5349-5383), aggiungere una quarta card accanto alle tre esistenti (cambiare `col-md-4` in `col-md-3` per le quattro, o aggiungere una nuova riga — usare `col-md-3` per farle stare tutte sulla stessa riga su schermi larghi):

```jsx
<div className="col-md-3">
  <div className="card shadow-sm h-100" style={{ borderLeft: '4px solid var(--ms-purple-600)' }}>
    <div className="card-body d-flex align-items-center gap-3">
      <div className="bg-light text-primary rounded p-3" style={{ fontSize: '1.4rem' }}><Euro /></div>
      <div>
        <span className="text-muted small block">Costo Totale</span>
        <div className="h4 mb-0 fw-bold">{globalStats ? `${(globalStats.totals.totalCostCents / 100).toFixed(2)} €` : '…'}</div>
      </div>
    </div>
  </div>
</div>
```

Aggiornare anche le tre card esistenti (`col-md-4` → `col-md-3`) per far stare tutte e quattro sulla stessa riga.

- [ ] **Step 4: Aggiungere card costo/risparmio in Statistiche**

Nella riga delle 4 card totals della vista Statistiche (circa righe 7604-7629), aggiungere una quinta card (o una riga separata sotto, per non rompere il layout `col-lg-3` a 4 colonne — usare una nuova `<div className="row g-3 mb-4">` dedicata subito dopo quella esistente):

```jsx
<div className="row g-3 mb-4">
  <div className="col-md-6">
    <div className="card shadow-sm text-center p-3">
      <span className="text-muted small">Costo Totale (SEND + POSTAL)</span>
      <h3 className="h2 mb-0 fw-bold text-primary">{(globalStats.totals.totalCostCents / 100).toFixed(2)} €</h3>
    </div>
  </div>
  <div className="col-md-6">
    <div className="card shadow-sm text-center p-3">
      <span className="text-muted small">Risparmio da Dirottamento (stimato)</span>
      <h3 className="h2 mb-0 fw-bold text-success">{(globalStats.totals.totalSavingCents / 100).toFixed(2)} €</h3>
    </div>
  </div>
</div>
```

Inserire questo blocco subito dopo la riga esistente delle 4 card totals (dentro lo stesso `{globalStats && (<>...</>)}`, non serve un nuovo guard).

- [ ] **Step 5: Verifica manuale in browser**

Navigare a Dashboard: card "Costo Totale" visibile. Navigare a Statistiche: card "Costo Totale" e "Risparmio da Dirottamento" visibili, valori coerenti con quanto verificato in Task 11 Step 3 per la campagna singola (il totale deve essere ≥ al costo della singola campagna test).

```bash
docker compose logs frontend-admin --since 1m 2>&1 | tail -20
```

Expected: nessun errore in console/log.

- [ ] **Step 6: Type-check frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): widget costo/risparmio in dashboard e statistiche"
```

---

### Task 14: Pulizia — verifica finale e aggiornamento CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (nuova sezione gotcha, se emersi durante l'implementazione)

**Interfaces:** nessuna — task di chiusura.

- [ ] **Step 1: Eseguire l'intera suite backend una volta finale**

```bash
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

Expected: stesso failure set noto pre-esistente (1 `isLdapMock`), nessuna regressione accumulata sui 13 task precedenti.

- [ ] **Step 2: Type-check completo backend + entrambi i frontend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
docker compose exec frontend-citizen node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore su tutti e tre.

- [ ] **Step 3: Verifica E2E manuale completa (checklist)**

- [ ] Dettaglio campagna SEND reale (se disponibile in ambiente test) mostra costo dopo un ciclo di cron.
- [ ] Dettaglio campagna `TEST REALE GlobalCom 2 - RaccomandataMarket4` mostra `4,31 €`.
- [ ] Dashboard mostra card "Costo Totale" popolata.
- [ ] Statistiche mostra "Costo Totale" e "Risparmio da Dirottamento" popolati, coerenti col dettaglio campagna.
- [ ] Una campagna EMAIL/PEC/APP_IO non mostra alcuna card costo nel dettaglio (verificare il guard `campaign.channelType === 'SEND' || campaign.channelType === 'POSTAL'`).

- [ ] **Step 4: Se emersi gotcha non documentati durante l'implementazione, aggiungerli a `CLAUDE.md`**

Es. se il vincolo "costo può arrivare dopo che lo stato è già terminale" (Task 4/7) si è rivelato diverso da quanto previsto, o se `paTaxId`/`noticeCode` risultano effettivamente recuperabili da qualche campo non previsto in fase di design, documentarlo nella sezione pertinente esistente o in una nuova sezione "Costo notifiche — gotcha", seguendo lo stile delle sezioni esistenti (fatto/perché/come applicarlo).

- [ ] **Step 5: Commit finale (se Step 4 ha prodotto modifiche)**

```bash
git add CLAUDE.md
git commit -m "docs: gotcha emersi durante implementazione costo notifiche"
```
