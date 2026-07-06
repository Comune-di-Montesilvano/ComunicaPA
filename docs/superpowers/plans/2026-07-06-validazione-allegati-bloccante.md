# Validazione Allegati Bloccante al Lancio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Oggi, se una campagna ha allegati mappati (es. 3 destinatari devono ricevere `xxx.pdf`, `xxx.pdf`, `xyz.pdf`) e l'operatore carica solo `xxx.pdf`, nulla blocca il lancio: la campagna parte, i 3 destinatari vengono messi in coda, e chi doveva ricevere `xyz.pdf` riceve al click di download un PDF generico auto-generato al posto dell'avviso vero — senza alcun segnale d'errore. Questo piano introduce un controllo bloccante: `POST /campaigns/:id/launch` verifica che ogni allegato referenziato da un destinatario sia effettivamente presente su disco, e se manca anche un solo file **non lancia nulla** (l'intera campagna resta in bozza) restituendo un errore con l'elenco dei file mancanti.

**Architettura:** Nuovo metodo privato `CampaignsService.findMissingAttachments(campaign)` che riusa `resolveAttachmentsConfig`/`resolveCustomAttachmentFilename` (già usati da `finalizeAttachments` e dal cleanup di retention) per calcolare, per ogni destinatario PENDING e ogni slot di allegato configurato, se il file atteso esiste nella cartella uploads della campagna. `launch()` chiama questo metodo prima di accodare qualunque job; se trova allegati mancanti, riporta lo stato campagna a `DRAFT` (compensando l'UPDATE atomico già eseguito) e lancia `BadRequestException` con il dettaglio. Il frontend propaga il messaggio di errore reale invece del testo generico attuale.

**Tech Stack:** NestJS (backend), React 19 + TypeScript (frontend-admin), Jest.

## Global Constraints

- Il controllo si applica solo se `resolveAttachmentsConfig(campaign.channelConfig)` restituisce almeno una entry — campagne senza allegati mappati non sono toccate da questo piano (comportamento identico a oggi).
- Il blocco è tutto-o-niente: se anche un solo destinatario tra quelli PENDING ha un file mancante, **nessun** destinatario viene lanciato (non è un lancio parziale).
- `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` per i test backend.

---

### Task 1: Blocco lato backend in `launch()`

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `resolveAttachmentsConfig(channelConfig)` e `resolveCustomAttachmentFilename(recipient, index)` da `apps/backend/src/attachments/attachment.service.ts` (esistenti, invariati). `getUploadsDir(campaignId)` da `apps/backend/src/attachments/attachment-paths.ts` (esistente, invariato).
- Produces: `CampaignsService.launch(campaignId)` lancia `BadRequestException` con messaggio `Impossibile avviare: N allegato/i mancante/i rispetto alla mappatura configurata — es. <filename> (CF <codiceFiscale>), ... . Carica i file mancanti prima di rilanciare.` quando ci sono allegati mancanti, e riporta lo stato della campagna a `DRAFT` prima di lanciare l'eccezione.

- [ ] **Step 1: Scrivi il test che fallisce**

Aggiungi in fondo a `apps/backend/src/campaigns/campaigns.service.spec.ts`, dentro `describe('CampaignsService', ...)`, un nuovo blocco (dopo `describe('finalizeAttachments', ...)`):

```ts
  describe('launch — validazione allegati bloccante', () => {
    beforeEach(() => {
      mockCampaignQb.execute.mockResolvedValue({ affected: 1 });
      mockCampaignRepo.createQueryBuilder.mockReturnValue(mockCampaignQb);
    });

    it('blocca il lancio e riporta la campagna a DRAFT se manca un allegato mappato', async () => {
      const campaignWithAttachments = {
        ...mockCampaign,
        id: 'c-att',
        channelConfig: { attachments: [{ key: 'file', label: 'Avviso TARI' }] },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaignWithAttachments);
      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        // prima chiamata (select id/codiceFiscale/extraData) = check allegati; seconda (select id, PENDING) = lancio
        if (select.includes('extraData')) {
          return Promise.resolve([
            { id: 'r1', codiceFiscale: 'AAA1', extraData: { file: 'xxx.pdf' } },
            { id: 'r2', codiceFiscale: 'BBB2', extraData: { file: 'xxx.pdf' } },
            { id: 'r3', codiceFiscale: 'CCC3', extraData: { file: 'xyz.pdf' } },
          ]);
        }
        return Promise.resolve([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
      });
      jest.spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => String(p).endsWith('xxx.pdf'));
      jest.spyOn(fs, 'readdirSync').mockReturnValue(['xxx.pdf'] as any);

      await expect(service.launch('c-att')).rejects.toThrow('Impossibile avviare');
      expect(mockCampaignRepo.update).toHaveBeenCalledWith({ id: 'c-att' }, { status: CampaignStatus.DRAFT });
      expect(mockQueue.addBulk).not.toHaveBeenCalled();
    });

    it('lancia normalmente se tutti gli allegati mappati sono presenti', async () => {
      const campaignWithAttachments = {
        ...mockCampaign,
        id: 'c-att-ok',
        channelConfig: { attachments: [{ key: 'file', label: 'Avviso TARI' }] },
      };
      mockCampaignRepo.findOneBy.mockResolvedValue(campaignWithAttachments);
      mockRecipientRepo.find.mockImplementation(({ select }: { select: string[] }) => {
        if (select.includes('extraData')) {
          return Promise.resolve([{ id: 'r1', codiceFiscale: 'AAA1', extraData: { file: 'xxx.pdf' } }]);
        }
        return Promise.resolve([{ id: 'r1' }]);
      });
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readdirSync').mockReturnValue(['xxx.pdf'] as any);

      const result = await service.launch('c-att-ok');
      expect(result.launched).toBe(1);
    });
  });
```

Verifica che in cima al file `campaigns.service.spec.ts` sia già presente `import * as fs from 'fs';` (sì, riga 9 — nessuna modifica agli import necessaria per questo task).

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: FAIL — il primo test si aspetta un `BadRequestException` con messaggio "Impossibile avviare" che oggi non viene lanciato (il lancio prosegue senza controllare gli allegati).

- [ ] **Step 3: Implementa `findMissingAttachments` e il gate in `launch()`**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiungi il metodo privato (es. subito prima di `finalizeAttachments`):

```ts
  /**
   * Calcola gli allegati mancanti: per ogni destinatario PENDING e ogni slot
   * configurato, verifica che il file referenziato in extraData esista
   * davvero nella cartella uploads della campagna. Usato per bloccare il
   * lancio (vedi `launch()`): se un file è mancante per anche un solo
   * destinatario, l'intera campagna non deve partire.
   */
  private async findMissingAttachments(
    campaign: Campaign,
  ): Promise<Array<{ recipientId: string; codiceFiscale: string; slotIndex: number; expectedFilename: string }>> {
    const attachmentsConfig = resolveAttachmentsConfig(campaign.channelConfig);
    if (attachmentsConfig.length === 0) return [];

    const dir = getUploadsDir(campaign.id);
    const present = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);

    const recipients = await this.recipientRepo.find({
      where: { campaignId: campaign.id, status: RecipientStatus.PENDING },
      select: ['id', 'codiceFiscale', 'extraData'],
    });

    const missing: Array<{ recipientId: string; codiceFiscale: string; slotIndex: number; expectedFilename: string }> = [];
    for (const r of recipients) {
      for (let index = 0; index < attachmentsConfig.length; index++) {
        const filename = resolveCustomAttachmentFilename(
          { campaign, extraData: r.extraData } as unknown as Recipient,
          index,
        );
        if (filename && !present.has(filename)) {
          missing.push({ recipientId: r.id, codiceFiscale: r.codiceFiscale, slotIndex: index, expectedFilename: filename });
        }
      }
    }
    return missing;
  }
```

Modifica `launch()` inserendo il controllo subito dopo il caricamento di `campaign` (dopo la riga `if (!campaign) throw new NotFoundException(...)`, prima del calcolo di `recipients`):

```ts
  async launch(campaignId: string): Promise<{ launched: number; campaignId: string }> {
    const launchResult = await this.campaignRepo
      .createQueryBuilder()
      .update()
      .set({ status: CampaignStatus.QUEUED })
      .where('id = :id AND status = :draft', { id: campaignId, draft: CampaignStatus.DRAFT })
      .execute();

    if (launchResult.affected === 0) {
      const exists = await this.campaignRepo.existsBy({ id: campaignId });
      if (!exists) throw new NotFoundException(`Campaign ${campaignId} not found`);
      throw new BadRequestException('Only draft campaigns can be launched');
    }

    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const missingAttachments = await this.findMissingAttachments(campaign);
    if (missingAttachments.length > 0) {
      await this.campaignRepo.update({ id: campaignId }, { status: CampaignStatus.DRAFT });
      const sample = missingAttachments
        .slice(0, 5)
        .map((m) => `${m.expectedFilename} (CF ${m.codiceFiscale})`)
        .join(', ');
      const more = missingAttachments.length > 5 ? ', …' : '';
      throw new BadRequestException(
        `Impossibile avviare: ${missingAttachments.length} allegato/i mancante/i rispetto alla mappatura configurata — es. ${sample}${more}. Carica i file mancanti prima di rilanciare.`,
      );
    }

    const recipients = await this.recipientRepo.find({
      where: { campaignId, status: RecipientStatus.PENDING },
      select: ['id'],
    });

    if (recipients.length === 0) {
      throw new BadRequestException('No pending recipients — upload a CSV first');
    }

    // ... resto del metodo invariato (bulk insert NotificationAttempts, accodamento job BullMQ, update recipients a QUEUED)
```

Nota: il resto del corpo di `launch()` (dal commento "Bulk insert NotificationAttempts..." in poi) resta identico a quello già presente nel file — questo step aggiunge solo il blocco `missingAttachments` e sposta il caricamento di `campaign` prima del calcolo `recipients` (già in quella posizione oggi, nessuno spostamento reale necessario: il codice esistente già carica `campaign` prima di `recipients`).

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: PASS su tutti i test del file, inclusi i test preesistenti di `launch()` (che usano `channelConfig: {}` e quindi `findMissingAttachments` restituisce sempre `[]` per loro — nessuna regressione).

- [ ] **Step 5: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "fix(backend): blocca il lancio campagna se mancano allegati mappati per qualche destinatario"
```

---

### Task 2: Il wizard mostra il messaggio di errore reale

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` (blocco di lancio dentro `handleWizLaunch`)

**Interfaces:**
- Consumes: risposta di errore di `POST /campaigns/:id/launch` — NestJS restituisce body `{ statusCode: 400, message: string, error: 'Bad Request' }` quando lancia `BadRequestException` (comportamento standard Nest, nessuna modifica lato backend necessaria oltre al Task 1).

- [ ] **Step 1: Sostituisci il controllo generico sull'esito del lancio**

In `apps/frontend-admin/src/App.tsx`, dentro `handleWizLaunch`, individua:

```tsx
      const launchRes = await fetch(`${API_BASE}/campaigns/${campaignObj.id}/launch`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!launchRes.ok) {
        throw new Error('Errore durante il lancio della campagna.');
      }
```

Sostituiscilo con:

```tsx
      const launchRes = await fetch(`${API_BASE}/campaigns/${campaignObj.id}/launch`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (!launchRes.ok) {
        const errBody = await launchRes.json().catch(() => null);
        throw new Error(errBody?.message || 'Errore durante il lancio della campagna.');
      }
```

Il blocco `catch (err: any) { ... alert(err.message); }` già presente in fondo a `handleWizLaunch` mostra già `err.message` all'operatore — nessuna altra modifica necessaria.

- [ ] **Step 2: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 3: Verifica manuale nel browser**

Crea una campagna EMAIL con mappatura allegato (una colonna CSV → 1 allegato), CSV con 3 destinatari che referenziano 2 filename diversi, carica solo 1 dei 2 file PDF richiesti, prova a lanciare. Verifica che appaia un alert con testo "Impossibile avviare: 1 allegato/i mancante/i..." e che la campagna resti visibile nell'elenco come DRAFT (non QUEUED).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "fix(frontend-admin): mostra messaggio reale di errore quando il lancio è bloccato per allegati mancanti"
```
