# Campaign group multicanale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere il canale libero per riga nel form "Invio Manuale" (introdotto dal Piano 1), lanciando N campagne single-channel esistenti sotto un `group_id` condiviso con un flusso guidato sequenziale, un solo lotto percepito dall'operatore ("un lancio, conta come una campagna" in lista).

**Architecture:** Backend: un solo campo nuovo (`campaigns.group_id`), zero altro cambio — ogni bucket-canale resta una `Campaign` normale, `channelConfig`/`*Strategy`/`launch()` invariati. Frontend: le righe accumulate (`wizManualRows`, Piano 1) guadagnano un campo `channel` libero; alla conferma, si raggruppano per canale effettivo (post-dirottamento INAD) in un "queue" di bucket; il wizard attraversa sequenzialmente lo step Template+Anteprima esistente per ciascun bucket (stesso codice già usato per il caso singolo canale, solo iterato), lanciando una campagna reale per bucket. La Lista Campagne aggrega client-side le righe con lo stesso `group_id` in una sola riga percepita.

**Tech Stack:** Stesso di Piano 1 — NestJS/TypeORM backend, React 19 frontend senza test runner (verifica manuale browser + tsc/lint).

**Spec:** `docs/superpowers/specs/2026-09-14-elenco-destinatari-da-form-design.md` (sezione "Multicanale via campaign group" e "Decisioni tecniche").

**Dipende da:** Piano 1 (`docs/superpowers/plans/2026-09-15-invio-manuale-multi-riga.md`, già implementato e mergiato/in PR #66) — questo piano estende `ManualRow`, `wizManualRows`, `handleWizManualSubmit`, `handleWizLaunch` introdotti/toccati lì.

## Global Constraints

- Ogni bucket-canale resta una `Campaign` reale esistente, invariata — nessuna ristrutturazione di `channelConfig`/Strategy.
- `group_id` si valorizza SOLO quando le righe del lotto coprono più di un canale effettivo distinto — un lotto a canale singolo (caso comune) si comporta esattamente come il Piano 1, nessun cambio percepito.
- Ogni punto che costruisce `channelConfig` per un lancio reale (`buildWizChannelConfigDraft` E `handleWizLaunch` — sono due copie parallele, vedi CLAUDE.md "Allegati e co-consegna App IO") va verificato per ENTRAMBI, non solo uno — gap segnalato esplicitamente in Task 7.
- Legal-value e protocollazione: se qualunque canale nel lotto li richiede obbligatoriamente, si propagano a TUTTE le sotto-campagne del gruppo, ricalcolati reattivamente (mai un flag "sticky" separato).
- Widget Dashboard/Statistiche restano fuori scope: continuano a contare le sotto-campagne singolarmente. Solo la Lista Campagne aggrega.
- Resume di una bozza "a metà gruppo" (alcuni bucket già lanciati, uno ancora in bozza) NON è supportato in modo particolare in questo piano — riprendere quella bozza riprende semplicemente il bucket corrente come campagna singola (comportamento Piano 1 invariato), i bucket già lanciati restano campagne concluse a sé stanti nello stesso gruppo. Documentato, non un gap silenzioso.

---

## Task 1: Backend — campo `group_id`

**Files:**
- Create: `apps/backend/src/database/migrations/1787300000000-AddCampaignGroupId.ts`
- Modify: `apps/backend/src/entities/campaign.entity.ts`
- Modify: `apps/backend/src/database/database.module.ts`
- Modify: `apps/backend/src/campaigns/dto/create-campaign.dto.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts:354-365` (`create()`)
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Produces: `Campaign.groupId: string | null`, `CreateCampaignDto.groupId?: string` — consumati dal frontend (Task 5/6) per taggare ogni bucket.

- [ ] **Step 1: Scrivi il test per `create()` con `groupId`**

In `apps/backend/src/campaigns/campaigns.service.spec.ts`, cerca il blocco di test esistente per `create()` (`grep -n "describe('create'" apps/backend/src/campaigns/campaigns.service.spec.ts`) e aggiungi:

```typescript
it('salva groupId quando presente nel DTO', async () => {
  const dto: CreateCampaignDto = {
    name: 'Test gruppo',
    channelType: 'SEND',
    channelConfig: {},
    groupId: 'group-uuid-1',
  };
  mockCampaignRepo.create.mockReturnValue({ ...dto, id: 'c1' });
  mockCampaignRepo.save.mockResolvedValue({ ...dto, id: 'c1' });

  await service.create(dto, 'operator1');

  expect(mockCampaignRepo.create).toHaveBeenCalledWith(
    expect.objectContaining({ groupId: 'group-uuid-1' }),
  );
});

it('groupId è null quando assente dal DTO', async () => {
  const dto: CreateCampaignDto = { name: 'Test singolo', channelType: 'EMAIL', channelConfig: {} };
  mockCampaignRepo.create.mockReturnValue({ ...dto, id: 'c2' });
  mockCampaignRepo.save.mockResolvedValue({ ...dto, id: 'c2' });

  await service.create(dto, 'operator1');

  expect(mockCampaignRepo.create).toHaveBeenCalledWith(
    expect.objectContaining({ groupId: null }),
  );
});
```

- [ ] **Step 2: Esegui i test, verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/vitest run campaigns.service.spec.ts -t "groupId"
```

Expected: FAIL — `groupId` non esiste ancora su `CreateCampaignDto`/`create()`.

- [ ] **Step 3: Entity — aggiungi la colonna**

In `apps/backend/src/entities/campaign.entity.ts`, subito dopo `externalClientId` (riga 79-80):

```typescript
  @Column({ type: 'uuid', name: 'group_id', nullable: true })
  groupId!: string | null;
```

- [ ] **Step 4: DTO — campo opzionale**

In `apps/backend/src/campaigns/dto/create-campaign.dto.ts`, aggiungi in cima al file `IsUUID` all'import esistente da `class-validator`, poi il campo dopo `isLegalValue`:

```typescript
  @IsUUID()
  @IsOptional()
  groupId?: string;
```

- [ ] **Step 5: Service — passa `groupId` a `create()`**

In `apps/backend/src/campaigns/campaigns.service.ts:354-365`:

```typescript
  create(dto: CreateCampaignDto, createdBy: string): Promise<Campaign> {
    const campaign = this.campaignRepo.create({
      name: dto.name,
      description: dto.description ?? null,
      channelType: dto.channelType,
      channelConfig: dto.channelConfig ?? {},
      status: CampaignStatus.DRAFT,
      createdBy,
      isLegalValue: dto.isLegalValue ?? false,
      groupId: dto.groupId ?? null,
    });
    return this.campaignRepo.save(campaign);
  }
```

- [ ] **Step 6: Migration**

Crea `apps/backend/src/database/migrations/1787300000000-AddCampaignGroupId.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCampaignGroupId1787300000000 implements MigrationInterface {
    name = 'AddCampaignGroupId1787300000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "campaigns" ADD "group_id" uuid`);
        await queryRunner.query(`CREATE INDEX "IDX_campaigns_group_id" ON "campaigns" ("group_id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_campaigns_group_id"`);
        await queryRunner.query(`ALTER TABLE "campaigns" DROP COLUMN "group_id"`);
    }
}
```

Registrala in `apps/backend/src/database/database.module.ts`: import in cima al file (accanto agli altri import di migration) e aggiungi `AddCampaignGroupId1787300000000` in fondo all'array `migrations:` (riga 83) — verifica con `grep -n "AddCampaignGroupId" apps/backend/src/database/database.module.ts` che compaia SIA nell'import SIA nell'array (gotcha noto in CLAUDE.md: una migration non registrata è invisibile, nessun errore).

- [ ] **Step 7: Esegui i test, verifica che passino**

```bash
docker compose exec backend node_modules/.bin/vitest run campaigns.service.spec.ts -t "groupId"
```

Expected: PASS.

- [ ] **Step 8: Type-check + applica lo schema in dev**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Dev usa `synchronize` (non le migration) — riavvia il backend per far allineare lo schema:

```bash
docker compose restart backend
```

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/entities/campaign.entity.ts apps/backend/src/database/database.module.ts apps/backend/src/database/migrations/1787300000000-AddCampaignGroupId.ts apps/backend/src/campaigns/dto/create-campaign.dto.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "$(cat <<'EOF'
feat: aggiunge campaigns.group_id per raggruppare lanci multicanale

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 2: Frontend — `ManualRow.channel` libero per riga

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:1282-1307` (`interface ManualRow`)
- Modify: `apps/frontend-admin/src/App.tsx` (`buildManualRowFromForm`, `startEditManualRow`, `commitCurrentManualRow`)
- Modify: `apps/frontend-admin/src/App.tsx:1152-1171` (`interface Campaign` — aggiunge `groupId`)

**Interfaces:**
- Consumes: `wizChannel` (esistente) come canale della riga in editing.
- Produces: `ManualRow.channel: 'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL'` — consumato da Task 3/5/6 per il bucketing.

- [ ] **Step 1: Aggiungi `channel` a `ManualRow`**

```bash
grep -n "^interface ManualRow" apps/frontend-admin/src/App.tsx
```

Subito dopo `id: string;`:

```typescript
interface ManualRow {
  id: string;
  channel: 'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL';
  cf: string;
  ...
```

- [ ] **Step 2: `buildManualRowFromForm` cattura `wizChannel`**

```bash
grep -n "const buildManualRowFromForm" apps/frontend-admin/src/App.tsx
```

Aggiungi `channel: wizChannel,` come primo campo dell'oggetto ritornato (subito dopo `id,`).

- [ ] **Step 3: `startEditManualRow` ripristina il canale**

```bash
grep -n "const startEditManualRow" apps/frontend-admin/src/App.tsx
```

Prima riga del corpo funzione, aggiungi `setWizChannel(row.channel);` (così il combobox "Canale di Invio Principale" mostra il canale della riga che si sta editando).

- [ ] **Step 4: Dedup resta per CF, indipendente dal canale**

Nessun cambio a `isManualCfDuplicate` — un CF non può comparire due volte nel lotto anche se su canali diversi (coerente con "impedire destinatario duplicato" deciso in brainstorming: un cittadino non riceve due notifiche della stessa campagna su due canali diversi per errore di battitura).

- [ ] **Step 5: `interface Campaign` — aggiungi `groupId`**

```bash
grep -n "^interface Campaign " apps/frontend-admin/src/App.tsx
```

Dopo `parentCampaignId: string | null;`:

```typescript
  groupId?: string | null;
```

- [ ] **Step 6: Type-check**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: 0 errori.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat: canale libero per riga in Invio Manuale (ManualRow.channel)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 3: Config specifica canale catturata alla prima riga

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (nuovo stato + logica capture/apply)
- Modify: `apps/frontend-admin/src/App.tsx` (form step1 wizSingleMode — mostra/nasconde i campi config canale)

**Interfaces:**
- Produces: `type ManualChannelConfig`, `wizManualChannelConfigs: Partial<Record<Channel, ManualChannelConfig>>`, `isFirstRowOfChannel(channel): boolean`, `captureManualChannelConfig(channel): void`, `applyManualChannelConfig(channel): void`.

- [ ] **Step 1: Tipo e stato**

Subito dopo `interface ManualRow` (Task 2):

```typescript
interface ManualChannelConfig {
  mailConfigId: string;
  taxonomyCode: string;
  physicalCommunicationType: string;
  postalServiceType: string;
  postalReturnReceipt: boolean;
  postalColorPrint: boolean;
  postalDuplex: boolean;
  postalAgolTipoNotificante: string;
  postalAgolSecondoTentativo: string;
  postalAgolNomeNotificante: string;
  postalAgolNumeroCronologico: string;
  postalCodiceContratto: string;
  ioServiceId: string;
}
```

Vicino a `wizManualEditingId` (Piano 1, Task 1):

```typescript
const [wizManualChannelConfigs, setWizManualChannelConfigs] = useState<
  Partial<Record<'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL', ManualChannelConfig>>
>({});
```

- [ ] **Step 2: `isFirstRowOfChannel` / capture / apply**

Vicino a `commitCurrentManualRow` (`grep -n "const commitCurrentManualRow" apps/frontend-admin/src/App.tsx`):

```typescript
const isFirstRowOfChannel = (channel: ManualRow['channel']): boolean =>
  !wizManualChannelConfigs[channel];

const captureManualChannelConfig = (channel: ManualRow['channel']) => {
  setWizManualChannelConfigs(prev => ({
    ...prev,
    [channel]: {
      mailConfigId: wizMailConfigId,
      taxonomyCode: wizTaxonomyCode,
      physicalCommunicationType: wizPhysicalCommunicationType,
      postalServiceType: wizPostalServiceType,
      postalReturnReceipt: wizPostalReturnReceipt,
      postalColorPrint: wizPostalColorPrint,
      postalDuplex: wizPostalDuplex,
      postalAgolTipoNotificante: wizPostalAgolTipoNotificante,
      postalAgolSecondoTentativo: wizPostalAgolSecondoTentativo,
      postalAgolNomeNotificante: wizPostalAgolNomeNotificante,
      postalAgolNumeroCronologico: wizPostalAgolNumeroCronologico,
      postalCodiceContratto: wizPostalCodiceContratto,
      ioServiceId: wizAppIoServiceId,
    },
  }));
};

const applyManualChannelConfig = (channel: ManualRow['channel']) => {
  const cfg = wizManualChannelConfigs[channel];
  if (!cfg) return;
  setWizMailConfigId(cfg.mailConfigId);
  setWizTaxonomyCode(cfg.taxonomyCode);
  setWizPhysicalCommunicationType(cfg.physicalCommunicationType);
  setWizPostalServiceType(cfg.postalServiceType);
  setWizPostalReturnReceipt(cfg.postalReturnReceipt);
  setWizPostalColorPrint(cfg.postalColorPrint);
  setWizPostalDuplex(cfg.postalDuplex);
  setWizPostalAgolTipoNotificante(cfg.postalAgolTipoNotificante);
  setWizPostalAgolSecondoTentativo(cfg.postalAgolSecondoTentativo);
  setWizPostalAgolNomeNotificante(cfg.postalAgolNomeNotificante);
  setWizPostalAgolNumeroCronologico(cfg.postalAgolNumeroCronologico);
  setWizPostalCodiceContratto(cfg.postalCodiceContratto);
  setWizAppIoServiceId(cfg.ioServiceId);
};
```

Verifica i nomi esatti dei setter con `grep -n "setWizPostalAgolTipoNotificante\|setWizPostalCodiceContratto\|setWizAppIoServiceId" apps/frontend-admin/src/App.tsx` prima di scrivere questo blocco — usa i nomi reali trovati (potrebbero differire leggermente da quanto sopra, questo blocco è la lista completa dei campi config-canale già individuati in `handleWizLaunch`/`buildWizChannelConfigDraft`, righe 7756-7812 e equivalenti).

- [ ] **Step 3: Wiring nel selettore canale**

```bash
grep -n "wizChannel, setWizChannel\] = useState" apps/frontend-admin/src/App.tsx
```

Il combobox "Canale di Invio Principale" (`onChange={e => setWizChannel(...)}`, cercalo con `grep -n "Canale di Invio Principale" apps/frontend-admin/src/App.tsx`) va esteso: quando l'operatore cambia canale E quel canale ha già una config catturata (`!isFirstRowOfChannel(nuovoCanale)`), applicarla subito:

```typescript
onChange={(e) => {
  const next = e.target.value as ManualRow['channel'];
  setWizChannel(next);
  if (!isFirstRowOfChannel(next)) applyManualChannelConfig(next);
}}
```

- [ ] **Step 4: Nascondi i campi config canale per righe successive dello stesso canale**

Ogni campo config-canale nel form (select mailConfig, taxonomyCode, postalServiceType, checkbox postalColorPrint/Duplex/ReturnReceipt, select ioServiceId) va avvolto in `{isFirstRowOfChannel(wizChannel) && (...)}`. Individua ogni blocco con:

```bash
grep -n "Server di Invio / Mittente\|Codice Tassonomia\|Tipologia.*[Ss]ervizio.*Postal\|Servizio App IO" apps/frontend-admin/src/App.tsx
```

Per ciascuno, avvolgi il blocco JSX esistente (label+input, non solo l'input) in `{isFirstRowOfChannel(wizChannel) && ( ... )}`. Quando nascosto, mostra invece una riga informativa:

```tsx
{!isFirstRowOfChannel(wizChannel) && (
  <div className="form-text small text-muted">
    Configurazione già impostata per questo canale (prima riga aggiunta) — verrà riusata.
  </div>
)}
```

- [ ] **Step 5: `commitCurrentManualRow` cattura la config alla prima riga del canale**

```bash
grep -n "const commitCurrentManualRow" apps/frontend-admin/src/App.tsx
```

Subito dopo il controllo dedup (`if (isManualCfDuplicate...)`), prima di costruire `row`:

```typescript
if (isFirstRowOfChannel(wizChannel)) captureManualChannelConfig(wizChannel);
```

- [ ] **Step 6: Reset — `wizManualChannelConfigs` azzerato in `resetWizard`**

```bash
grep -n "setWizManualRows(\[\]);" apps/frontend-admin/src/App.tsx
```

Subito dopo, in `resetWizard()`:

```typescript
setWizManualChannelConfigs({});
```

- [ ] **Step 7: Verifica manuale in browser**

Invio Manuale: aggiungi una riga SEND (compila taxonomyCode), poi cambia canale a PEC (compila mailConfigId), poi torna a SEND per una seconda riga — verifica che i campi taxonomyCode NON vengano richiesti di nuovo (banner "già impostata") e che il valore precedente sia effettivamente riapplicato (controllare che il payload finale usi lo stesso taxonomyCode per entrambe le righe SEND, verificabile dal Task 6 in poi una volta implementato il bucketing — annotare e riverificare a quel punto se questo step isolato non è ancora testabile end-to-end).

- [ ] **Step 8: Type-check + commit**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat: config specifica canale catturata alla prima riga del canale

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 4: Legal-value / protocollo reattivi su tutto il gruppo

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (nuove funzioni derivate)

**Interfaces:**
- Consumes: `wizManualRows`, `isChannelAlwaysLegalValue` (esistente, riga 691).
- Produces: `groupForcesLegalValue(): boolean`, `groupForcesProtocol(): boolean` — consumati da Task 6/7.

- [ ] **Step 1: Funzioni derivate**

Vicino a `isManualCfDuplicate`:

```typescript
const groupForcesLegalValue = (): boolean =>
  wizManualRows.some(r => isChannelAlwaysLegalValue(r.channel, wizManualChannelConfigs[r.channel]?.postalServiceType));

const groupForcesProtocol = (): boolean =>
  wizManualRows.some(r => r.channel === 'SEND');
```

- [ ] **Step 2: Verifica manuale**

Non c'è ancora UI che le usa (arrivano nel Task 6/7) — verifica solo che compilino:

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat: legal-value/protocollo reattivi sui canali presenti nel lotto

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 5: Bucket queue + transizione al primo canale

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (nuovo stato gruppo + `handleWizManualSubmit`)

**Interfaces:**
- Produces: `wizGroupChannels: ManualRow['channel'][]`, `wizGroupIndex: number`, `wizGroupId: string | null` — consumati da Task 6/7.
- Consumes: `handleWizManualSubmit` (Piano 1).

- [ ] **Step 1: Stato gruppo**

Vicino a `wizManualEditingId`:

```typescript
const [wizGroupChannels, setWizGroupChannels] = useState<ManualRow['channel'][]>([]);
const [wizGroupIndex, setWizGroupIndex] = useState(0);
const [wizGroupId, setWizGroupId] = useState<string | null>(null);
```

- [ ] **Step 2: Calcolo bucket in `handleWizManualSubmit`**

```bash
grep -n "const handleWizManualSubmit" apps/frontend-admin/src/App.tsx
```

Subito dopo il blocco che valida `rows.length === 0`/nome campagna (righe già presenti da Piano 1), prima di costruire il CSV, sostituisci la sezione di costruzione CSV con il calcolo bucket + delega:

```typescript
const effectiveChannel = (row: ManualRow): ManualRow['channel'] => (row.inadForced ? 'PEC' : row.channel);
const distinctChannels = Array.from(new Set(rows.map(effectiveChannel)));

if (distinctChannels.length > 1 && !wizGroupId) {
  setWizGroupChannels(distinctChannels);
  setWizGroupIndex(0);
  setWizGroupId(crypto.randomUUID());
}
const activeGroupChannels = distinctChannels.length > 1 ? distinctChannels : [];
const currentBucketChannel = activeGroupChannels.length > 0 ? activeGroupChannels[0] : wizChannel;
setWizChannel(currentBucketChannel);
if (!isFirstRowOfChannel(currentBucketChannel)) applyManualChannelConfig(currentBucketChannel);
```

Nota: `distinctChannels.length > 1` è la condizione che decide se attivare il meccanismo di gruppo — un lotto a canale singolo (distinctChannels.length === 1) salta interamente questa logica, `wizGroupId` resta `null`, comportamento identico al Piano 1.

- [ ] **Step 3: CSV filtrato per bucket corrente**

Sostituisci `rows.forEach(row => {...})` (il loop che costruisce le righe CSV, introdotto in Piano 1 Task 5) con:

```typescript
const bucketRows = activeGroupChannels.length > 0
  ? rows.filter(r => effectiveChannel(r) === currentBucketChannel)
  : rows;

bucketRows.forEach(row => {
  // ... corpo invariato del forEach esistente (Piano 1) ...
});
```

Il `targetStep` passato alla funzione resta quello calcolato da `wizSingleNeedsTemplateStep` per `currentBucketChannel` (non più per `wizChannel` letto prima del calcolo bucket) — verifica che `wizSingleNeedsTemplateStep` (riga 1951) sia ricalcolato correttamente dato che ora dipende da `wizChannel` già aggiornato allo Step 2 sopra (è già una `const` derivata ad ogni render, nessun cambio necessario lì).

- [ ] **Step 4: Verifica manuale**

Aggiungi 2 righe EMAIL + 1 riga SEND, clicca "Conferma e Invia" — verifica via devtools console che `wizGroupChannels` sia `['EMAIL', 'SEND']` (o l'ordine di comparsa reale) e `wizChannel` sia passato al primo bucket. Il flusso non è ancora completo (manca l'avanzamento al bucket successivo, Task 7) — fermati dopo aver verificato lo stato.

- [ ] **Step 5: Type-check + commit**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat: calcolo bucket canale + CSV filtrato per bucket corrente

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 6: `buildWizChannelConfigDraft` — `groupId` + forzatura legal/protocollo

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:7262` circa (`buildWizChannelConfigDraft`)
- Modify: `apps/frontend-admin/src/App.tsx:7391` circa (`syncWizDraftAndRecipients` — passaggio `groupId`/`isLegalValue` alla POST)

**Interfaces:**
- Consumes: `wizGroupId`, `groupForcesLegalValue`, `groupForcesProtocol` (Task 4/5).

- [ ] **Step 1: Verifica il punto esatto dove la POST crea la campagna**

```bash
grep -n "const syncWizDraftAndRecipients" apps/frontend-admin/src/App.tsx
```

Leggi l'intera funzione (già nota da Piano 1: fa `POST /campaigns` se `!wizCampaignId`, altrimenti `PATCH`). Nel body della POST, aggiungi:

```typescript
body: JSON.stringify({
  name: wizName,
  description: wizDesc,
  channelType: wizChannel,
  channelConfig,
  isLegalValue: isChannelAlwaysLegalValue(wizChannel, wizPostalServiceType) || wizIsLegalValue || groupForcesLegalValue(),
  groupId: wizGroupId ?? undefined,
}),
```

- [ ] **Step 2: `buildWizChannelConfigDraft` — forza `protocolla` se il gruppo lo richiede**

```bash
grep -n "const buildWizChannelConfigDraft" apps/frontend-admin/src/App.tsx
```

Cerca dove questa funzione imposta `channelConfig.protocolla` (per canali diversi da SEND, pattern analogo a `handleWizLaunch` riga 7826-7828: `if (wizChannel !== 'SEND') channelConfig.protocolla = wizProtocolla;`). Sostituisci con:

```typescript
if (wizChannel !== 'SEND') {
  channelConfig.protocolla = wizProtocolla || groupForcesProtocol();
}
```

- [ ] **Step 3: Verifica manuale**

Ripeti il test del Task 5 (2 EMAIL + 1 SEND), avanza fino alla creazione della prima bozza (bucket EMAIL) — verifica in `docker compose logs -f backend` o via devtools Network che la richiesta POST includa `groupId` e `isLegalValue: true` (forzato dal SEND presente nel lotto, anche se il bucket corrente è EMAIL).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat: buildWizChannelConfigDraft/syncWizDraftAndRecipients propagano
group_id e forzatura legal-value/protocollo di gruppo

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 7: `handleWizLaunch` — avanzamento al bucket successivo + `groupId`

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:7730-7947` (`handleWizLaunch`)

**Interfaces:**
- Consumes: `wizGroupChannels`, `wizGroupIndex`, `wizGroupId`, `applyManualChannelConfig`, `groupForcesLegalValue`, `groupForcesProtocol` (Task 3/4/5).

- [ ] **Step 1: `groupId` + forzatura nel POST/PATCH di `handleWizLaunch`**

```bash
grep -n "const handleWizLaunch = async" apps/frontend-admin/src/App.tsx
```

Stesso identico gap del Task 6 ma nella copia "lancio reale": la creazione campagna (riga ~7872-7885) va aggiornata:

```typescript
body: JSON.stringify({
  name: wizName,
  description: wizDesc || wizSubject || wizName,
  channelType: wizChannel,
  channelConfig,
  isLegalValue: isChannelAlwaysLegalValue(wizChannel, wizPostalServiceType) || wizIsLegalValue || groupForcesLegalValue(),
  groupId: wizGroupId ?? undefined,
}),
```

E il blocco `if (wizChannel !== 'SEND') { channelConfig.protocolla = wizProtocolla; }` (riga 7826-7828) diventa:

```typescript
if (wizChannel !== 'SEND') {
  channelConfig.protocolla = wizProtocolla || groupForcesProtocol();
}
```

(Stesso identico cambio del Task 6 Step 2 — le due copie vanno tenute sincronizzate, è esattamente il gap segnalato in fase di design.)

- [ ] **Step 2: Sostituisci il tail di successo**

```bash
grep -n "resetWizard();" apps/frontend-admin/src/App.tsx
```

Trova il blocco (dopo `if (launchData?.blocked) { throw ... }`, righe ~7932-7940):

```typescript
// PRIMA
      resetWizard();

      fetchCampaigns();
      setView('dashboard');

      alert('Campagna creata e avviata con successo! I messaggi sono in coda.');
      if (launchData?.signatureWarning) {
        alert(`Attenzione: ${launchData.signatureWarning}`);
      }

// DOPO
      if (launchData?.signatureWarning) {
        alert(`Attenzione: ${launchData.signatureWarning}`);
      }

      const hasNextBucket = wizGroupChannels.length > 0 && wizGroupIndex < wizGroupChannels.length - 1;
      if (hasNextBucket) {
        const justLaunchedChannel = wizChannel;
        const nextIndex = wizGroupIndex + 1;
        const nextChannel = wizGroupChannels[nextIndex];
        setWizGroupIndex(nextIndex);
        setWizChannel(nextChannel);
        applyManualChannelConfig(nextChannel);
        setWizCampaignId(null);
        setWizSubject('');
        setWizBody('');
        setWizCsvFile(null);
        setWizCsvHeaders([]);
        setWizCsvRows([]);
        setWizValidRows([]);
        setWizAttachments([]);
        setWizPdfFiles([]);
        setWizRecipientsSyncFingerprint(null);
        const needsTemplateStep = nextChannel === 'EMAIL' || nextChannel === 'PEC' || nextChannel === 'APP_IO';
        setWizStep(needsTemplateStep ? 4 : 6);
        alert(`Canale "${justLaunchedChannel}" del gruppo lanciato. Procedi con il prossimo canale: "${nextChannel}".`);
      } else {
        resetWizard();
        fetchCampaigns();
        setView('dashboard');
        alert(
          wizGroupChannels.length > 0
            ? 'Gruppo multicanale completato: tutte le campagne sono state avviate.'
            : 'Campagna creata e avviata con successo! I messaggi sono in coda.'
        );
      }
```

Nota: gli allegati (`wizPdfFiles`/`wizAttachments`) restano gli stessi file già caricati per il bucket precedente (stesso "allegato comune" del lotto) — non vanno azzerati come file selezionati dall'operatore ma solo come stato di upload per la NUOVA campagna (che è un `Campaign` id diverso sul server, servirà un nuovo upload). Verifica in Task 9 che il passaggio da un bucket all'altro ricarichi correttamente l'allegato comune sulla nuova campagna (la funzione che li carica, `ensureWizSingleAttachmentsUploaded`/equivalente in `handleWizManualSubmit`, riceve già `uploadFiles` esplicito — se il bucket successivo richiede lo stesso file, va ripassato al prossimo giro di `handleWizManualSubmit` quando si arriva di nuovo allo step Template, non risolvibile automaticamente da `handleWizLaunch` da solo: annota come rischio noto da verificare in QA, non silenziarlo).

- [ ] **Step 3: Type-check**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat: handleWizLaunch avanza al bucket-canale successivo del gruppo

Stesso gap di sincronizzazione channelConfig di buildWizChannelConfigDraft
(vedi CLAUDE.md "Allegati e co-consegna App IO") applicato qui: groupId
e forzatura legal-value/protocollo replicati identici al Task 6.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 8: Reset stato gruppo + UI "canale N di M" durante il flusso

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (`resetWizard`)
- Modify: `apps/frontend-admin/src/App.tsx:11536` circa (step Template — banner progresso)

**Interfaces:**
- Consumes: `wizGroupChannels`, `wizGroupIndex`, `wizGroupId`.

- [ ] **Step 1: Reset**

```bash
grep -n "setWizManualChannelConfigs(\{\});" apps/frontend-admin/src/App.tsx
```

Subito dopo (dentro `resetWizard`):

```typescript
setWizGroupChannels([]);
setWizGroupIndex(0);
setWizGroupId(null);
```

- [ ] **Step 2: Banner progresso nello step Template**

```bash
grep -n "wizStep === 4 &&" apps/frontend-admin/src/App.tsx
```

Subito dopo l'apertura del blocco (prima del contenuto esistente dello step), aggiungi:

```tsx
{wizGroupChannels.length > 0 && (
  <div className="alert alert-info d-flex align-items-center gap-2 mb-3">
    <Info size={16} />
    <div>
      Lancio multicanale: canale <strong>{wizChannel}</strong> ({wizGroupIndex + 1} di {wizGroupChannels.length}) — {wizGroupChannels.join(', ')}.
    </div>
  </div>
)}
```

Verifica che `Info` sia già importato da `lucide-react` (`grep -n "Info," apps/frontend-admin/src/App.tsx` — già presente nell'elenco import visto in Piano 1 Task 6).

- [ ] **Step 3: Stesso banner nello step Anteprima e Invio**

```bash
grep -n "wizStep === 6 &&" apps/frontend-admin/src/App.tsx
```

Stesso blocco JSX del Step 2, subito dopo l'apertura.

- [ ] **Step 4: Verifica manuale + type-check**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Nel browser, lotto con 2 canali: verifica che il banner compaia con il conteggio corretto in entrambi gli step.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat: reset stato gruppo + banner progresso canale N di M

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 9: Nudge INAD eterogeneo

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (tabella righe, Piano 1 Task 6)

**Interfaces:**
- Consumes: `wizManualRows` (campo `inadForced` già presente da Piano 1).

- [ ] **Step 1: Banner nella tabella righe**

```bash
grep -n "Destinatari aggiunti (" apps/frontend-admin/src/App.tsx
```

Subito prima della tabella (dentro il blocco `{wizManualRows.length > 0 && (...)}` introdotto in Piano 1 Task 6), aggiungi:

```tsx
{(() => {
  const hasDiverted = wizManualRows.some(r => r.inadForced);
  const hasNonPec = wizManualRows.some(r => r.channel !== 'PEC' && !r.inadForced);
  if (!hasDiverted || !hasNonPec) return null;
  return (
    <div className="alert alert-warning d-flex align-items-start gap-2 mb-3">
      <AlertCircle size={16} className="mt-1 flex-shrink-0" />
      <div>
        Il lotto ha destinatari con domicili digitali eterogenei (alcuni dirottati da INAD su PEC, altri no) — valuta SEND: gestisce entrambi i casi in un solo canale, senza dividere il lancio in più bucket.
      </div>
    </div>
  );
})()}
```

- [ ] **Step 2: Verifica manuale**

Serve un CF reale con domicilio digitale già noto al sistema di test/mock INAD per verificare `inadForced: true` dal vivo — se non disponibile in dev, verifica solo che la condizione non dia falsi positivi con righe normali (nessun banner quando tutte le righe sono omogenee).

- [ ] **Step 3: Type-check + commit**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat: nudge informativo per domicili digitali eterogenei nel lotto

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 10: Lista Campagne — aggregazione client-side per `group_id`

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:8061-8086` (`getFilteredCampaigns`)
- Modify: `apps/frontend-admin/src/App.tsx` (nuova funzione `aggregateCampaignGroups`)
- Modify: `apps/frontend-admin/src/App.tsx:9261-9267` circa (view `invio-massivo`, pipeline filtro/gruppo/paginazione)
- Modify: dettaglio campagna (sezione "fa parte del lancio gruppo")

**Interfaces:**
- Produces: `aggregateCampaignGroups(campaigns: Campaign[]): Campaign[]` — righe sintetiche con `groupId`/`groupMemberIds`/`groupChannels` per i gruppi, righe originali invariate per le campagne singole.

- [ ] **Step 1: Estendi `interface Campaign` con i campi sintetici**

```bash
grep -n "groupId?: string | null;" apps/frontend-admin/src/App.tsx
```

Subito dopo (Task 2 Step 5), aggiungi:

```typescript
  // Presenti SOLO sulla riga sintetica generata da aggregateCampaignGroups()
  // per un gruppo multicanale — mai su una Campaign reale dal backend.
  isGroupAggregate?: boolean;
  groupMemberIds?: string[];
  groupChannels?: Array<'PEC' | 'EMAIL' | 'APP_IO' | 'SEND' | 'POSTAL'>;
```

- [ ] **Step 2: `aggregateCampaignGroups`**

Subito prima di `getFilteredCampaigns` (riga 8061):

```typescript
// Un lancio multicanale (stesso group_id) conta come UNA campagna in
// lista — conteggi sommati, stato peggiore vince, canale = elenco dei
// canali coinvolti. Opera sull'elenco COMPLETO prima di filtro/ricerca/
// paginazione, così il raggruppamento è corretto indipendentemente da
// quale pagina/filtro l'operatore sta guardando (vedi discussione design:
// niente raggruppamento server-side, findAll() non pagina comunque).
const STATUS_SEVERITY: Record<Campaign['status'], number> = {
  failed: 6, running: 5, checking_inad: 4, queued: 3, draft: 2, completed: 1, cancelled: 0,
};

const aggregateCampaignGroups = (source: Campaign[]): Campaign[] => {
  const byGroup = new Map<string, Campaign[]>();
  const ungrouped: Campaign[] = [];
  for (const c of source) {
    if (!c.groupId) { ungrouped.push(c); continue; }
    const list = byGroup.get(c.groupId) || [];
    list.push(c);
    byGroup.set(c.groupId, list);
  }

  const aggregates: Campaign[] = [];
  for (const [groupId, members] of byGroup) {
    if (members.length === 1) { ungrouped.push(members[0]); continue; }
    const sorted = [...members].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const primary = sorted[0];
    const worstStatus = sorted.reduce((worst, m) =>
      STATUS_SEVERITY[m.status] > STATUS_SEVERITY[worst] ? m.status : worst, sorted[0].status);
    aggregates.push({
      ...primary,
      status: worstStatus,
      totalRecipients: sorted.reduce((sum, m) => sum + m.totalRecipients, 0),
      sentCount: sorted.reduce((sum, m) => sum + m.sentCount, 0),
      failedCount: sorted.reduce((sum, m) => sum + m.failedCount, 0),
      isGroupAggregate: true,
      groupMemberIds: sorted.map(m => m.id),
      groupChannels: Array.from(new Set(sorted.map(m => m.channelType))),
    });
    void groupId;
  }

  return [...ungrouped, ...aggregates].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
};
```

- [ ] **Step 3: Applica l'aggregazione prima del filtro**

```typescript
// PRIMA (riga 8061-8062)
  const getFilteredCampaigns = (): Campaign[] => {
    let result = campaigns;

// DOPO
  const getFilteredCampaigns = (): Campaign[] => {
    let result = aggregateCampaignGroups(campaigns);
```

- [ ] **Step 4: Ricerca testuale sui canali di gruppo**

Nello stesso blocco (riga 8064-8073), il filtro `c.channelType.toLowerCase().includes(q)` non trova nulla su una riga aggregata multicanale (channelType resta quello del membro primario). Estendi:

```typescript
    if (campaignSearch.trim()) {
      const q = campaignSearch.trim().toLowerCase();
      result = result.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (c.description || '').toLowerCase().includes(q) ||
        c.channelType.toLowerCase().includes(q) ||
        (c.groupChannels || []).some(ch => ch.toLowerCase().includes(q)) ||
        c.status.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q)
      );
    }
```

- [ ] **Step 5: Badge multi-canale nella riga lista**

```bash
grep -n "getChannelMeta(c.channelType)\|getChannelMeta(campaign.channelType)" apps/frontend-admin/src/App.tsx
```

Nel punto dove la riga campagna renderizza il badge canale (dentro il blocco `paginated.map(...)`, view `invio-massivo`), avvolgi:

```tsx
{c.isGroupAggregate && c.groupChannels ? (
  <div className="d-flex gap-1 flex-wrap">
    {c.groupChannels.map(ch => {
      const meta = getChannelMeta(ch);
      return <span key={ch} className="badge" style={{ background: meta.color }}>{meta.label}</span>;
    })}
  </div>
) : (
  /* rendering esistente invariato per una singola campagna */
)}
```

- [ ] **Step 6: Click su riga aggregata apre il membro primario**

```bash
grep -n "onClick.*openCampaignDetail(c.id)\|onClick.*openCampaignDetail(campaign.id)" apps/frontend-admin/src/App.tsx
```

`c.id` sulla riga sintetica è già l'id del membro primario (Step 2, `...primary`) — nessun cambio necessario al click, apre correttamente il dettaglio del membro primario.

- [ ] **Step 7: Sezione "fa parte del lancio gruppo" nel dettaglio campagna**

```bash
grep -n "const openCampaignDetail" apps/frontend-admin/src/App.tsx
```

Nel rendering del dettaglio campagna (cerca l'header con nome/canale/stato campagna, `grep -n "campaign.name\b" apps/frontend-admin/src/App.tsx` per individuare il punto), se `campaign.groupId` è presente:

```tsx
{campaign.groupId && (() => {
  const siblings = campaigns.filter(c => c.groupId === campaign.groupId && c.id !== campaign.id);
  if (siblings.length === 0) return null;
  return (
    <div className="alert alert-light border d-flex flex-column gap-1 mb-3">
      <strong className="small">Fa parte di un lancio multicanale:</strong>
      {siblings.map(s => (
        <a key={s.id} href="#" className="small" onClick={(e) => { e.preventDefault(); openCampaignDetail(s.id); }}>
          {getChannelMeta(s.channelType).label} — {s.totalRecipients} destinatari — {s.status}
        </a>
      ))}
    </div>
  );
})()}
```

- [ ] **Step 8: Verifica manuale end-to-end**

Nel browser: lancia un gruppo con 2 canali (Task 5-7 devono essere già completi), verifica in Lista Campagne che appaia UNA riga con badge multi-canale e conteggio destinatari sommato, apri il dettaglio e verifica il link alla sorella.

- [ ] **Step 9: Type-check + commit**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat: Lista Campagne aggrega lanci multicanale come una riga sola

Client-side, su fetch completo prima di filtro/paginazione — findAll()
backend non pagina comunque, nessun cambio lato server oltre group_id.
Dettaglio campagna mostra link alle sorelle dello stesso gruppo.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01XNcvXko6EwbgxpPN5jq6B6
EOF
)"
```

---

## Task 11: QA end-to-end multicanale

**Files:** nessuna modifica, solo verifica.

- [ ] **Step 1: Type-check + lint completi**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
docker compose exec frontend-admin node_modules/.bin/eslint src/App.tsx
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/vitest run
```

Expected: 0 errori tsc/backend test (failure set identico alla baseline nota, vedi CLAUDE.md), 0 nuovi errori eslint rispetto a Piano 1.

- [ ] **Step 2: Scenario reale — ordinanza a lotto misto (caso portato in brainstorming)**

Nel browser, canale iniziale SEND: aggiungi 3 destinatari SEND (con allegato PDF firmato o test mock), cambia canale a PEC, aggiungi 2 destinatari PEC (con mailConfig). Clicca "Conferma e Invia":
- Verifica banner "canale 1 di 2" nello step Template SEND.
- Compila oggetto/taxonomy, avanza, lancia il bucket SEND.
- Verifica avanzamento automatico al bucket PEC (step Template, banner "canale 2 di 2").
- Compila oggetto/body PEC, lancia.
- Verifica alert finale "Gruppo multicanale completato".

- [ ] **Step 3: Verifica lista + dettaglio**

In Lista Campagne: verifica UNA riga con badge SEND+PEC, 5 destinatari totali. Apri il dettaglio, verifica il link alla sorella e che navighi correttamente.

- [ ] **Step 4: Verifica log backend**

```bash
docker compose logs --tail=50 backend | grep -iv "error_message"
```

Nessun errore reale (escludendo il falso positivo già noto della colonna `error_message` nei log SQL).

- [ ] **Step 5: Verifica caso a canale singolo invariato (non-regressione Piano 1)**

Invio Manuale, un solo canale, 2 destinatari — verifica che il comportamento sia IDENTICO a Piano 1 (nessun banner gruppo, `group_id` mai valorizzato, nessuna riga aggregata in lista).

- [ ] **Step 6: Nessun commit in questo task** — solo verifica. Bug emersi vanno corretti con task ad-hoc seguendo lo stesso ciclo verifica/commit degli altri task.
