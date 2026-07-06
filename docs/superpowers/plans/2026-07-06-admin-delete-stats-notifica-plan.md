# Elimina Campagna, Statistiche Multicanale, Dettaglio Notifica Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tre feature admin di ComunicaPA: (1) cancellazione campagna con destinatari/tentativi/allegati, solo admin; (2) breakdown statistiche per canale/co-consegna App IO nel dettaglio campagna; (3) maschera dettaglio notifica (storico tentativi + anteprima messaggio ricostruita) nella ricerca notifiche, oggi assente.

**Architettura:** Tutte e tre riusano dati/logica già esistenti senza nuove tabelle: il breakdown multicanale legge `NotificationAttempt.responsePayload` (già scritto da `notification.processor.ts`); la cancellazione si appoggia al cascade DB già presente nelle migration (`ON DELETE CASCADE` verificato); il dettaglio notifica riusa lo stesso motore di rendering di `previewMessage()` (estratto in un metodo condiviso `renderMessage`), applicato a un destinatario reale invece che transitorio.

**Tech Stack:** NestJS (backend), React 19 + TypeScript (frontend-admin), Jest.

## Global Constraints

- Nessuna migration DB nuova: il cascade `ON DELETE CASCADE` per `recipients→campaigns` e `notification_attempts→recipients` è già presente nelle migration applicate (verificato in `1783023440824-InitialSchema.ts` e `1783148719725-FixRecipientCampaignJoin.ts`).
- Route di cancellazione: `@Roles('admin')` a livello di singolo metodo (pattern già in uso in `io-services.controller.ts`/`mail-configs.controller.ts`), controller resta `@Roles('user', 'admin')` per il resto.
- Nessuna nuova dipendenza npm.
- `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` per i test backend (se in un ambiente dove `docker compose` collide con uno stack già attivo, usare il pattern `docker run` equivalente descritto nel Task 1). `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` per il type-check frontend.

---

### Task 1: Backend — breakdown statistiche multicanale

**Files:**
- Modify: `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `resolveSecondaryAppIoConfig(channelConfig)` da `apps/backend/src/channels/secondary-channels.util.ts` (esistente, invariato).
- Produces: `CampaignsService.getChannelBreakdown(campaignId: string): Promise<ChannelBreakdownDto | null>`. Route `GET /admin/campaigns/:id/channel-stats` → `{ campaignId: string, breakdown: ChannelBreakdownDto | null }`.

- [ ] **Step 1: Scrivi il DTO**

Aggiungi in fondo a `apps/backend/src/campaigns/dto/campaign-stats.dto.ts`:

```ts
export interface ChannelBreakdownDto {
  primaryOnly: number;
  both: number;
  appIoOnly: number;
  appIoDespitePrimaryFail: number;
  neither: number;
}
```

- [ ] **Step 2: Scrivi il test che fallisce**

Aggiungi in fondo a `apps/backend/src/campaigns/campaigns.service.spec.ts` (dentro `describe('CampaignsService', ...)`):

```ts
  describe('getChannelBreakdown', () => {
    it('ritorna null se la campagna non ha co-consegna App IO configurata', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({ ...mockCampaign, channelConfig: {} });

      const result = await service.getChannelBreakdown('uuid-1');

      expect(result).toBeNull();
      expect(mockRecipientRepo.find).not.toHaveBeenCalled();
    });

    it('classifica correttamente le 5 categorie di consegna', async () => {
      mockCampaignRepo.findOneBy.mockResolvedValueOnce({
        ...mockCampaign,
        channelConfig: { appIo: { mode: 'parallel', ioServiceId: 'svc-1' } },
      });
      mockRecipientRepo.find.mockResolvedValueOnce([
        { id: 'r-primary-only', status: RecipientStatus.SENT },
        { id: 'r-both', status: RecipientStatus.SENT },
        { id: 'r-appio-only', status: RecipientStatus.SENT },
        { id: 'r-appio-despite-fail', status: RecipientStatus.FAILED },
        { id: 'r-neither', status: RecipientStatus.FAILED },
        { id: 'r-pending', status: RecipientStatus.PENDING },
      ]);
      mockAttemptRepo.find.mockResolvedValueOnce([
        { recipientId: 'r-primary-only', responsePayload: {} },
        { recipientId: 'r-both', responsePayload: { appIo: { success: true } } },
        { recipientId: 'r-appio-only', responsePayload: { appIo: { success: true }, deliveredVia: 'APP_IO' } },
        { recipientId: 'r-appio-despite-fail', responsePayload: { appIo: { success: true } } },
        { recipientId: 'r-neither', responsePayload: { appIo: { success: false, error: 'timeout' } } },
      ]);

      const result = await service.getChannelBreakdown('uuid-1');

      expect(result).toEqual({
        primaryOnly: 1,
        both: 1,
        appIoOnly: 1,
        appIoDespitePrimaryFail: 1,
        neither: 1,
      });
    });
  });
```

Aggiungi il mock `find` su `mockAttemptRepo` se non già presente (verifica l'oggetto esistente nel file — se `mockAttemptRepo` ha solo `createQueryBuilder`, aggiungi `find: jest.fn()` all'oggetto letterale e resettalo con `mockAttemptRepo.find.mockReset()` nel `beforeEach` esistente, accanto agli altri reset).

- [ ] **Step 3: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "getChannelBreakdown" --maxWorkers=2`

Se `docker compose` non è utilizzabile nell'ambiente (collide con uno stack già attivo con lo stesso project name), usa:
```bash
WT="$(pwd)"
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$WT/apps/backend/src:/app/apps/backend/src" \
  -v "$WT/packages/shared-types/src:/app/packages/shared-types/src" \
  -v comunicapa_backend_node_modules:/app/node_modules \
  -w /app/apps/backend \
  comunicapa/backend:dev \
  node_modules/.bin/jest campaigns.service -t "getChannelBreakdown" --maxWorkers=2
```
Expected: FAIL — `getChannelBreakdown is not a function`.

- [ ] **Step 4: Implementa `getChannelBreakdown`**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiungi l'import:

```ts
import { In } from 'typeorm';
import { resolveSecondaryAppIoConfig } from '../channels/secondary-channels.util';
import type { ChannelBreakdownDto } from './dto/campaign-stats.dto';
```

(Nota: `Repository` è già importato da `'typeorm'` — aggiungi `In` alla stessa riga di import esistente invece di una riga separata: `import { In, Repository } from 'typeorm';`.)

Aggiungi il metodo pubblico, subito dopo `getStats`:

```ts
  /**
   * Breakdown per canale/co-consegna App IO. Ritorna null se la campagna non
   * ha co-consegna configurata (nessuna sezione da mostrare). Il segnale App IO
   * esiste solo sul PRIMO tentativo (job.attemptsMade === 0 in
   * notification.processor.ts — la co-consegna non viene mai ritentata), quindi
   * si legge solo attemptNumber=1; lo stato primario invece è quello ATTUALE
   * del destinatario (aggiornato anche dai retry).
   */
  async getChannelBreakdown(campaignId: string): Promise<ChannelBreakdownDto | null> {
    const campaign = await this.campaignRepo.findOneBy({ id: campaignId });
    if (!campaign) throw new NotFoundException(`Campaign ${campaignId} not found`);

    if (!resolveSecondaryAppIoConfig(campaign.channelConfig)) return null;

    const recipients = await this.recipientRepo.find({
      where: { campaignId },
      select: ['id', 'status'],
    });

    const breakdown: ChannelBreakdownDto = { primaryOnly: 0, both: 0, appIoOnly: 0, appIoDespitePrimaryFail: 0, neither: 0 };
    const toClassify = recipients.filter(
      (r) => r.status === RecipientStatus.SENT || r.status === RecipientStatus.FAILED,
    );
    if (toClassify.length === 0) return breakdown;

    const firstAttempts = await this.attemptRepo.find({
      where: { recipientId: In(toClassify.map((r) => r.id)), attemptNumber: 1 },
      select: ['recipientId', 'responsePayload'],
    });
    const payloadByRecipient = new Map(firstAttempts.map((a) => [a.recipientId, a.responsePayload]));

    for (const r of toClassify) {
      const payload = payloadByRecipient.get(r.id);
      const appIo = payload?.['appIo'] as { success?: boolean } | undefined;
      const deliveredViaAppIo = payload?.['deliveredVia'] === 'APP_IO';
      const appIoSucceeded = !!appIo?.success;
      const primarySucceeded = r.status === RecipientStatus.SENT && !deliveredViaAppIo;

      if (primarySucceeded && appIoSucceeded) breakdown.both++;
      else if (primarySucceeded) breakdown.primaryOnly++;
      else if (deliveredViaAppIo && appIoSucceeded) breakdown.appIoOnly++;
      else if (r.status === RecipientStatus.FAILED && appIoSucceeded) breakdown.appIoDespitePrimaryFail++;
      else breakdown.neither++;
    }
    return breakdown;
  }
```

- [ ] **Step 5: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "getChannelBreakdown" --maxWorkers=2` (o l'equivalente `docker run` sopra)
Expected: PASS entrambi i test.

- [ ] **Step 6: Aggiungi la route**

In `apps/backend/src/campaigns/campaigns.controller.ts`, aggiungi subito dopo `getStats`:

```ts
  @Get(':id/channel-stats')
  getChannelBreakdown(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignsService.getChannelBreakdown(id).then((breakdown) => ({ campaignId: id, breakdown }));
  }
```

- [ ] **Step 7: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit` (o l'equivalente `docker run` con `node_modules/.bin/tsc --noEmit` al posto di jest)
Expected: nessun errore.

- [ ] **Step 8: Commit**

```bash
git add apps/backend/src/campaigns/dto/campaign-stats.dto.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): breakdown statistiche multicanale per co-consegna App IO"
```

---

### Task 2: Frontend — mostra il breakdown multicanale nel dettaglio campagna

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `GET ${ADMIN_API_BASE}/campaigns/:id/channel-stats` (Task 1), risposta `{ campaignId: string, breakdown: { primaryOnly, both, appIoOnly, appIoDespitePrimaryFail, neither } | null }`.

- [ ] **Step 1: Aggiungi lo state**

Vicino alla dichiarazione di `campaignFailures` (cerca `const [campaignFailures, setCampaignFailures]`), aggiungi:

```tsx
  const [channelBreakdown, setChannelBreakdown] = useState<{ primaryOnly: number; both: number; appIoOnly: number; appIoDespitePrimaryFail: number; neither: number } | null>(null);
```

- [ ] **Step 2: Fetcha il breakdown insieme al dettaglio campagna**

In `handleCampaignClick` (circa riga 2158), che oggi contiene:

```tsx
  const handleCampaignClick = (id: string) => {
    setSelectedCampaignId(id);
    setView('campaign-detail');
    setCampaign(null);
    setCsvFile(null);
    setCsvHeaders([]);
    setCsvRows([]);
    setUploadSuccess(false);
    setCsvError(null);
    setCampaignFailures([]);
    fetchCampaignDetail(id);
    fetchCampaignFailures(id);
  };
```

sostituisci con:

```tsx
  const handleCampaignClick = (id: string) => {
    setSelectedCampaignId(id);
    setView('campaign-detail');
    setCampaign(null);
    setCsvFile(null);
    setCsvHeaders([]);
    setCsvRows([]);
    setUploadSuccess(false);
    setCsvError(null);
    setCampaignFailures([]);
    setChannelBreakdown(null);
    fetchCampaignDetail(id);
    fetchCampaignFailures(id);
    fetchChannelBreakdown(id);
  };

  const fetchChannelBreakdown = async (id: string) => {
    try {
      const res = await apiFetch(`/campaigns/${id}/channel-stats`);
      if (!res.ok) return;
      const data = await res.json();
      setChannelBreakdown(data.breakdown);
    } catch {
      // Non bloccante: la pagina dettaglio resta usabile senza il breakdown.
    }
  };
```

- [ ] **Step 3: Renderizza il blocco**

Nel dettaglio campagna, subito dopo il blocco "Stato dell'Invio" esistente (`App.tsx:4917-4937`, che chiude con `)}` prima di `{campaignFailures.length > 0 && (`), aggiungi:

```tsx
                        {channelBreakdown && (
                          <div className="mt-4 border-top pt-3">
                            <h4 className="small fw-bold mb-2">
                              <i className="fas fa-mobile-screen me-1 text-primary"></i>Dettaglio Consegna Multicanale
                            </h4>
                            <div className="small">
                              <div className="d-flex justify-content-between mb-1">
                                <span><i className="fas fa-envelope text-muted me-1"></i>Solo canale primario</span>
                                <span className="fw-bold">{channelBreakdown.primaryOnly}</span>
                              </div>
                              <div className="d-flex justify-content-between mb-1">
                                <span><i className="fas fa-check-double text-success me-1"></i>Anche App IO (parallela)</span>
                                <span className="fw-bold">{channelBreakdown.both}</span>
                              </div>
                              <div className="d-flex justify-content-between mb-1">
                                <span><i className="fas fa-mobile-screen text-success me-1"></i>Solo App IO (esclusiva)</span>
                                <span className="fw-bold">{channelBreakdown.appIoOnly}</span>
                              </div>
                              <div className="d-flex justify-content-between mb-1">
                                <span><i className="fas fa-triangle-exclamation text-warning me-1"></i>App IO riuscito, primario fallito</span>
                                <span className="fw-bold">{channelBreakdown.appIoDespitePrimaryFail}</span>
                              </div>
                              <div className="d-flex justify-content-between">
                                <span><i className="fas fa-times text-danger me-1"></i>Nessuno dei due (fallito)</span>
                                <span className="fw-bold">{channelBreakdown.neither}</span>
                              </div>
                            </div>
                          </div>
                        )}

```

- [ ] **Step 4: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 5: Verifica manuale nel browser**

Apri il dettaglio di una campagna EMAIL/PEC con co-consegna App IO configurata: verifica che il blocco "Dettaglio Consegna Multicanale" appaia con i 5 conteggi. Apri il dettaglio di una campagna SENZA co-consegna: verifica che il blocco non appaia affatto.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): mostra breakdown consegna multicanale nel dettaglio campagna"
```

---

### Task 3: Backend — elimina campagna (solo admin)

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`
- Test: `apps/backend/src/campaigns/campaigns.controller.spec.ts`

**Interfaces:**
- Consumes: `getUploadsDir(campaignId)` da `apps/backend/src/attachments/attachment-paths.ts` (esistente, invariato).
- Produces: `CampaignsService.remove(campaignId: string): Promise<{ deleted: true }>`. Route `DELETE /admin/campaigns/:id`, `@Roles('admin')`.

- [ ] **Step 1: Scrivi il test che fallisce (service)**

Aggiungi in `apps/backend/src/campaigns/campaigns.service.spec.ts`:

```ts
  describe('remove', () => {
    it('lancia NotFoundException se la campagna non esiste', async () => {
      mockCampaignRepo.existsBy.mockResolvedValueOnce(false);

      await expect(service.remove('no-exist')).rejects.toThrow(NotFoundException);
      expect(mockCampaignRepo.delete).not.toHaveBeenCalled();
    });

    it('rimuove la cartella allegati su disco e cancella la campagna (cascade DB su recipients/attempts)', async () => {
      mockCampaignRepo.existsBy.mockResolvedValueOnce(true);
      mockCampaignRepo.delete = jest.fn().mockResolvedValue(undefined);
      const rmSpy = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);

      const result = await service.remove('c-del');

      expect(rmSpy).toHaveBeenCalledWith(expect.stringContaining('c-del'), { recursive: true, force: true });
      expect(mockCampaignRepo.delete).toHaveBeenCalledWith('c-del');
      expect(result).toEqual({ deleted: true });

      rmSpy.mockRestore();
    });
  });
```

Verifica che `mockCampaignRepo` nel file abbia già `existsBy: jest.fn()` (sì, già usato da `launch()` — vedi test esistenti riga ~131-136) e aggiungi `delete: jest.fn()` all'oggetto letterale `mockCampaignRepo` se non già presente.

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "remove" --maxWorkers=2`
Expected: FAIL — `service.remove is not a function`.

- [ ] **Step 3: Implementa `remove`**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiungi subito dopo `getChannelBreakdown` (o in fondo alla classe, prima dell'ultima `}`):

```ts
  async remove(campaignId: string): Promise<{ deleted: true }> {
    const exists = await this.campaignRepo.existsBy({ id: campaignId });
    if (!exists) throw new NotFoundException(`Campaign ${campaignId} not found`);

    await fs.promises.rm(getUploadsDir(campaignId), { recursive: true, force: true });
    await this.campaignRepo.delete(campaignId);

    return { deleted: true };
  }
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "remove" --maxWorkers=2`
Expected: PASS entrambi i test.

- [ ] **Step 5: Scrivi il test controller che fallisce**

In `apps/backend/src/campaigns/campaigns.controller.spec.ts`, aggiungi `remove: jest.fn().mockResolvedValue({ deleted: true })` all'oggetto `mockService`, poi aggiungi:

```ts
  describe('remove', () => {
    it('delega a campaignsService.remove', async () => {
      const result = await controller.remove('uuid-1');
      expect(mockService.remove).toHaveBeenCalledWith('uuid-1');
      expect(result).toEqual({ deleted: true });
    });
  });
```

- [ ] **Step 6: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.controller -t "remove" --maxWorkers=2`
Expected: FAIL — `controller.remove is not a function`.

- [ ] **Step 7: Aggiungi la route**

In `apps/backend/src/campaigns/campaigns.controller.ts`, aggiungi `Delete` all'import da `@nestjs/common` (riga 1-15: aggiungi `Delete,` in ordine alfabetico dopo `Body,`), poi aggiungi il metodo subito dopo `getRecipientStats` (ultimo metodo della classe):

```ts
  @Delete(':id')
  @Roles('admin')
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<{ deleted: true }> {
    return this.campaignsService.remove(id);
  }
```

- [ ] **Step 8: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.controller -t "remove" --maxWorkers=2`
Expected: PASS.

- [ ] **Step 9: Suite completa e type-check**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` e `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: tutti i test passano (baseline + nuovi), nessun errore di tipo.

- [ ] **Step 10: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.service.spec.ts apps/backend/src/campaigns/campaigns.controller.spec.ts
git commit -m "feat(backend): elimina campagna (solo admin) con cascade destinatari/tentativi e pulizia allegati"
```

---

### Task 4: Frontend — bottone "Elimina" (solo admin)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `DELETE ${ADMIN_API_BASE}/campaigns/:id` (Task 3). Stato `role` già esistente (`App.tsx:129`, valori `'admin'`/`'user'`).

- [ ] **Step 1: Aggiungi l'handler**

Vicino a `handleDuplicateCampaign`/`handleResumeDraft` (circa riga 1804-1827), aggiungi:

```tsx
  const handleDeleteCampaign = async (id: string, name: string) => {
    if (!confirm(`Eliminare definitivamente la campagna "${name}"? Verranno cancellati destinatari, tentativi di invio e allegati. Azione irreversibile.`)) {
      return;
    }
    const res = await apiFetch(`/campaigns/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      alert('Impossibile eliminare la campagna.');
      return;
    }
    fetchCampaigns();
    if (selectedCampaignId === id) {
      setView('invio-massivo');
    }
  };
```

- [ ] **Step 2: Aggiungi il bottone nella lista campagne**

Nella riga azioni della lista campagne (`App.tsx:2889-2908`), subito dopo il bottone "Duplica" (prima della chiusura `</td>`):

```tsx
                                  {role === 'admin' && (
                                    <button
                                      type="button"
                                      className="btn btn-sm btn-outline-danger d-flex align-items-center gap-1 mt-1"
                                      title="Elimina campagna definitivamente"
                                      onClick={() => handleDeleteCampaign(c.id, c.name)}
                                    >
                                      <i className="fas fa-trash"></i> Elimina
                                    </button>
                                  )}
```

- [ ] **Step 3: Aggiungi il bottone nel dettaglio campagna**

Nel blocco finale della card metadati (`App.tsx:4972-4991`, quello che contiene "Lancia Campagna"), dopo la chiusura del blocco `{campaign.totalRecipients === 0 && campaign.status === 'draft' && (...)}`e prima della chiusura `</div>` del blocco `mt-4 border-top pt-3`:

```tsx
                          {role === 'admin' && (
                            <button
                              className="btn btn-outline-danger w-100 py-2 fw-semibold mt-2"
                              onClick={() => handleDeleteCampaign(campaign.id, campaign.name)}
                            >
                              <i className="fas fa-trash me-2"></i>Elimina Campagna
                            </button>
                          )}
```

- [ ] **Step 4: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 5: Verifica manuale nel browser**

Login come admin: verifica bottone "Elimina" visibile in lista e dettaglio, conferma cancellazione, verifica che la campagna sparisca dalla lista e che la cartella allegati su disco sia stata rimossa. Login come operatore non-admin: verifica che il bottone NON appaia.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): bottone elimina campagna (solo admin) in lista e dettaglio"
```

---

### Task 5: Backend — dettaglio notifica (storico tentativi + anteprima ricostruita)

**Files:**
- Create: `apps/backend/src/notifications-search/dto/notification-detail.dto.ts`
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (estrae `renderMessage`, aggiunge `renderMessageForRecipient`)
- Modify: `apps/backend/src/campaigns/campaigns.module.ts` (esporta `CampaignsService`)
- Modify: `apps/backend/src/notifications-search/notifications-search.module.ts` (importa `CampaignsModule`, registra `NotificationAttempt`)
- Modify: `apps/backend/src/notifications-search/notifications-search.service.ts`
- Modify: `apps/backend/src/notifications-search/notifications-search.controller.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts` (verifica che il refactor non rompa `previewMessage`)
- Test: `apps/backend/src/notifications-search/notifications-search.service.spec.ts`

**Interfaces:**
- Consumes: `PreviewMessageResult` da `apps/backend/src/campaigns/dto/preview-message.dto.ts` (esistente, invariato). `resolveAttachmentsConfig(channelConfig)` da `apps/backend/src/attachments/attachment.service.ts` (esistente, invariato).
- Produces: `CampaignsService.renderMessageForRecipient(recipientId: string): Promise<PreviewMessageResult>` (pubblico, usato da `NotificationsSearchService`). `NotificationsSearchService.getDetail(recipientId: string): Promise<NotificationDetailDto>`. Route `GET /admin/notifications-search/:recipientId`.

- [ ] **Step 1: Crea il DTO del dettaglio**

```ts
// apps/backend/src/notifications-search/dto/notification-detail.dto.ts
import type { PreviewMessageResult } from '../../campaigns/dto/preview-message.dto';

export interface AttemptDetailDto {
  attemptNumber: number;
  status: string;
  channelType: string;
  errorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
  appIo: { attempted: false } | { attempted: true; success: boolean; error: string | null };
}

export interface NotificationDetailDto {
  recipient: {
    id: string;
    codiceFiscale: string;
    fullName: string | null;
    email: string | null;
    pec: string | null;
    status: string;
  };
  campaign: {
    id: string;
    name: string;
    channelType: string;
  };
  attempts: AttemptDetailDto[];
  preview: PreviewMessageResult;
}
```

- [ ] **Step 2: Scrivi il test che fallisce per il refactor `previewMessage`/`renderMessage`**

Il test esistente su `previewMessage` in `apps/backend/src/campaigns/campaigns.service.spec.ts` (dentro `describe('previewMessage', ...)`) deve continuare a passare **senza modifiche** — è la prova che il refactor non cambia il contratto pubblico. Non aggiungere nulla in questo step: esegui subito la suite esistente per avere una baseline.

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "previewMessage" --maxWorkers=2`
Expected: PASS (baseline pre-refactor, da confermare identica anche dopo).

- [ ] **Step 3: Estrai `renderMessage` e aggiungi `renderMessageForRecipient`**

In `apps/backend/src/campaigns/campaigns.service.ts`, sostituisci il metodo `previewMessage` esistente (righe 92-125) con:

```ts
  async previewMessage(dto: PreviewMessageDto): Promise<PreviewMessageResult> {
    const previewRecipient = {
      id: randomUUID(),
      codiceFiscale: dto.recipient.codiceFiscale,
      fullName: dto.recipient.fullName ?? null,
      email: dto.recipient.email ?? null,
      pec: dto.recipient.pec ?? null,
      extraData: dto.recipient.extraData ?? {},
    } as unknown as Recipient;

    const attachmentLabels = (dto.attachments ?? []).map((a) => a.label);
    return this.renderMessage(dto.channelType, dto.subject, dto.body, attachmentLabels, previewRecipient, dto.format);
  }

  /**
   * Rende oggetto+corpo di un destinatario REALE (già persistito), per la
   * maschera di dettaglio notifica nella ricerca — mostra esattamente ciò
   * che è stato realmente inviato, con lo stesso motore di `previewMessage`
   * (nessuna duplicazione di logica).
   */
  async renderMessageForRecipient(recipientId: string): Promise<PreviewMessageResult> {
    const recipient = await this.recipientRepo.findOne({ where: { id: recipientId }, relations: ['campaign'] });
    if (!recipient) throw new NotFoundException(`Recipient ${recipientId} not found`);

    const campaign = recipient.campaign;
    const subjectTemplate = (campaign.channelConfig?.['subject'] as string) || campaign.name;
    const bodyTemplate = (campaign.channelConfig?.['body'] as string) || '';
    const attachmentLabels = resolveAttachmentsConfig(campaign.channelConfig).map((a) => a.label);

    return this.renderMessage(campaign.channelType, subjectTemplate, bodyTemplate, attachmentLabels, recipient);
  }

  private async renderMessage(
    channelType: string,
    subjectTemplate: string,
    bodyTemplate: string,
    attachmentLabels: string[],
    recipientLike: Recipient,
    format?: 'html' | 'markdown',
  ): Promise<PreviewMessageResult> {
    const brandName = (await this.settings.get<string>('brand.name')) || 'Comune di Montesilvano';
    const publicApiUrl = await this.settings.get<string>('system.publicUrl');
    const downloadLinkSecret = this.config.get('downloadLink.secret', { infer: true });
    const retentionMaxDays = await this.settings.get<number>('retention.maxDays');
    const retentionDays = getEffectiveRetentionDays({ retentionDays: null }, retentionMaxDays);
    const expiresAtUnix = Math.floor(Date.now() / 1000) + retentionDays * 86400;
    const resolvedFormat: 'html' | 'markdown' = format ?? (channelType === 'APP_IO' ? 'markdown' : 'html');

    const subject = processTemplate(subjectTemplate, recipientLike, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, resolvedFormat);
    const body = processTemplate(bodyTemplate, recipientLike, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, resolvedFormat);

    if (resolvedFormat === 'markdown') {
      return { subject, bodyMarkdown: body };
    }

    const brandLogo = await this.settings.get<string>('brand.logo');
    const logoUrl = brandLogo ? (/^https?:\/\//i.test(brandLogo) ? brandLogo : `${publicApiUrl}/branding/logo`) : null;
    const portalUrl = (await this.settings.get<string>('system.citizenPublicUrl')) || null;
    const bodyHtml = wrapInHtmlLayout(body, brandName, { logoUrl, portalUrl });

    return { subject, bodyHtml };
  }
```

Nota: `dto.recipient.codiceFiscale`/ecc. in `previewMessage` restano identici a prima — solo il corpo che calcolava subject/body/html è stato estratto in `renderMessage`. Il contratto pubblico di `previewMessage` (parametri, tipo di ritorno, comportamento) non cambia.

- [ ] **Step 4: Esegui il test e verifica che passi (nessuna regressione)**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: PASS su tutta la suite, inclusi i test preesistenti di `previewMessage` — comportamento identico a prima del refactor.

- [ ] **Step 5: Esporta `CampaignsService` dal modulo**

In `apps/backend/src/campaigns/campaigns.module.ts`, aggiungi `exports`:

```ts
@Module({
  imports: [
    TypeOrmModule.forFeature([Campaign, Recipient, NotificationAttempt]),
    QueueModule,
  ],
  providers: [CampaignsService, RetentionCleanupService],
  controllers: [CampaignsController],
  exports: [CampaignsService],
})
export class CampaignsModule {}
```

- [ ] **Step 6: Scrivi il test che fallisce per `getDetail`**

Aggiungi in fondo a `apps/backend/src/notifications-search/notifications-search.service.spec.ts`:

```ts
describe('NotificationsSearchService.getDetail', () => {
  const recipientRepoMock = {
    createQueryBuilder: jest.fn(),
    findOne: jest.fn(),
  };
  const attemptRepoMock = { find: jest.fn() };
  const campaignsServiceMock = { renderMessageForRecipient: jest.fn() };

  let service: NotificationsSearchService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsSearchService,
        { provide: getRepositoryToken(Recipient), useValue: recipientRepoMock },
        { provide: getRepositoryToken(NotificationAttempt), useValue: attemptRepoMock },
        { provide: CampaignsService, useValue: campaignsServiceMock },
      ],
    }).compile();
    service = moduleRef.get(NotificationsSearchService);
  });

  it('lancia NotFoundException se il destinatario non esiste', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce(null);

    await expect(service.getDetail('no-exist')).rejects.toThrow(NotFoundException);
  });

  it('ritorna destinatario, campagna, tentativi ed esito App IO separato', async () => {
    recipientRepoMock.findOne.mockResolvedValueOnce({
      id: 'r1',
      codiceFiscale: 'RSSMRA80A01H501X',
      fullName: 'Mario Rossi',
      email: 'mario@test.it',
      pec: null,
      status: 'sent',
      campaign: { id: 'c1', name: 'Avviso TARI', channelType: 'EMAIL' },
    });
    attemptRepoMock.find.mockResolvedValueOnce([
      {
        attemptNumber: 1,
        status: 'success',
        channelType: 'EMAIL',
        errorMessage: null,
        sentAt: new Date('2026-07-01T10:00:00Z'),
        createdAt: new Date('2026-07-01T09:59:00Z'),
        responsePayload: { appIo: { success: true } },
      },
    ]);
    campaignsServiceMock.renderMessageForRecipient.mockResolvedValueOnce({ subject: 'Ciao Mario', bodyHtml: '<p>Corpo</p>' });

    const result = await service.getDetail('r1');

    expect(result).toEqual({
      recipient: {
        id: 'r1',
        codiceFiscale: 'RSSMRA80A01H501X',
        fullName: 'Mario Rossi',
        email: 'mario@test.it',
        pec: null,
        status: 'sent',
      },
      campaign: { id: 'c1', name: 'Avviso TARI', channelType: 'EMAIL' },
      attempts: [{
        attemptNumber: 1,
        status: 'success',
        channelType: 'EMAIL',
        errorMessage: null,
        sentAt: '2026-07-01T10:00:00.000Z',
        createdAt: '2026-07-01T09:59:00.000Z',
        appIo: { attempted: true, success: true, error: null },
      }],
      preview: { subject: 'Ciao Mario', bodyHtml: '<p>Corpo</p>' },
    });
  });
});
```

Aggiungi gli import necessari in cima al file (`NotFoundException` da `@nestjs/common`, `NotificationAttempt` da `../entities/notification-attempt.entity`, `CampaignsService` da `../campaigns/campaigns.service`).

- [ ] **Step 7: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest notifications-search --maxWorkers=2`
Expected: FAIL — `service.getDetail is not a function`.

- [ ] **Step 8: Implementa `getDetail`**

In `apps/backend/src/notifications-search/notifications-search.service.ts`, aggiungi gli import:

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { CampaignsService } from '../campaigns/campaigns.service';
import type { NotificationDetailDto } from './dto/notification-detail.dto';
```

Aggiorna il costruttore:

```ts
  constructor(
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    private readonly campaignsService: CampaignsService,
  ) {}
```

Aggiungi il metodo, dopo `search`:

```ts
  async getDetail(recipientId: string): Promise<NotificationDetailDto> {
    const recipient = await this.recipientRepo.findOne({
      where: { id: recipientId },
      relations: ['campaign'],
    });
    if (!recipient) throw new NotFoundException(`Recipient ${recipientId} not found`);

    const attempts = await this.attemptRepo.find({
      where: { recipientId },
      order: { attemptNumber: 'ASC' },
    });

    const preview = await this.campaignsService.renderMessageForRecipient(recipientId);

    return {
      recipient: {
        id: recipient.id,
        codiceFiscale: recipient.codiceFiscale,
        fullName: recipient.fullName,
        email: recipient.email,
        pec: recipient.pec,
        status: recipient.status,
      },
      campaign: {
        id: recipient.campaign.id,
        name: recipient.campaign.name,
        channelType: recipient.campaign.channelType,
      },
      attempts: attempts.map((a) => {
        const appIoPayload = a.responsePayload?.['appIo'] as { success?: boolean; error?: string } | undefined;
        return {
          attemptNumber: a.attemptNumber,
          status: a.status,
          channelType: a.channelType,
          errorMessage: a.errorMessage,
          sentAt: a.sentAt ? a.sentAt.toISOString() : null,
          createdAt: a.createdAt.toISOString(),
          appIo: appIoPayload
            ? { attempted: true as const, success: !!appIoPayload.success, error: appIoPayload.error ?? null }
            : { attempted: false as const },
        };
      }),
      preview,
    };
  }
```

- [ ] **Step 9: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest notifications-search --maxWorkers=2`
Expected: PASS su tutti i test del file (esistenti + nuovi).

- [ ] **Step 10: Aggiorna il modulo**

In `apps/backend/src/notifications-search/notifications-search.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { NotificationsSearchService } from './notifications-search.service';
import { NotificationsSearchController } from './notifications-search.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Recipient, NotificationAttempt]), CampaignsModule],
  controllers: [NotificationsSearchController],
  providers: [NotificationsSearchService],
})
export class NotificationsSearchModule {}
```

- [ ] **Step 11: Aggiungi la route**

In `apps/backend/src/notifications-search/notifications-search.controller.ts`, aggiungi `Param` e `ParseUUIDPipe` all'import da `@nestjs/common`:

```ts
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
```

Aggiungi il metodo dopo `search`:

```ts
  @Get(':recipientId')
  getDetail(@Param('recipientId', ParseUUIDPipe) recipientId: string) {
    return this.svc.getDetail(recipientId);
  }
```

- [ ] **Step 12: Suite completa e type-check**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` e `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: tutti i test passano, nessun errore di tipo. Verifica in particolare che non ci sia una dipendenza circolare a runtime (Nest lancerebbe un errore esplicito all'avvio se ci fosse — `CampaignsModule` non importa `NotificationsSearchModule`, quindi la dipendenza resta unidirezionale).

- [ ] **Step 13: Commit**

```bash
git add apps/backend/src/notifications-search/dto/notification-detail.dto.ts apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.module.ts apps/backend/src/notifications-search/notifications-search.module.ts apps/backend/src/notifications-search/notifications-search.service.ts apps/backend/src/notifications-search/notifications-search.controller.ts apps/backend/src/campaigns/campaigns.service.spec.ts apps/backend/src/notifications-search/notifications-search.service.spec.ts
git commit -m "feat(backend): endpoint dettaglio notifica con storico tentativi e anteprima ricostruita"
```

---

### Task 6: Frontend — maschera dettaglio notifica

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `GET ${ADMIN_API_BASE}/notifications-search/:recipientId` (Task 5), risposta `NotificationDetailDto` (vedi Task 5 Step 1 per la shape esatta).

- [ ] **Step 1: Aggiungi lo state**

Vicino a `searchResults`/`searchTotal` (circa riga 148-150), aggiungi:

```tsx
  const [notifDetail, setNotifDetail] = useState<{
    recipient: { id: string; codiceFiscale: string; fullName: string | null; email: string | null; pec: string | null; status: string };
    campaign: { id: string; name: string; channelType: string };
    attempts: Array<{ attemptNumber: number; status: string; channelType: string; errorMessage: string | null; sentAt: string | null; createdAt: string; appIo: { attempted: false } | { attempted: true; success: boolean; error: string | null } }>;
    preview: { subject: string; bodyHtml?: string; bodyMarkdown?: string };
  } | null>(null);
  const [notifDetailLoading, setNotifDetailLoading] = useState(false);
```

- [ ] **Step 2: Aggiungi l'handler di apertura**

Vicino a `runNotificationSearch` (circa riga 174), aggiungi:

```tsx
  const openNotificationDetail = async (recipientId: string) => {
    setNotifDetail(null);
    setNotifDetailLoading(true);
    try {
      const res = await fetch(`${ADMIN_API_BASE}/notifications-search/${recipientId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        alert('Impossibile caricare il dettaglio della notifica.');
        return;
      }
      setNotifDetail(await res.json());
    } finally {
      setNotifDetailLoading(false);
    }
  };
```

- [ ] **Step 3: Rendi cliccabile la riga**

In `App.tsx:3878-3885`, sostituisci:

```tsx
                        <tr key={r.recipientId}>
```

con:

```tsx
                        <tr key={r.recipientId} style={{ cursor: 'pointer' }} onClick={() => openNotificationDetail(r.recipientId)}>
```

- [ ] **Step 4: Aggiungi il modal**

Subito dopo la chiusura del blocco `{view === 'notifiche-ricerca' && (...)}` (cerca la sua chiusura `)}` — è il blocco che contiene la tabella risultati, chiude circa alla riga 3908 dell'attuale file, verifica il punto esatto cercando `runNotificationSearch(searchPage + 1)` seguito dalla chiusura del `div` principale e poi `)}`), aggiungi il modal come blocco **fratello** (fuori da `{view === 'notifiche-ricerca' && (...)}`, così resta montato indipendentemente dalla view corrente):

```tsx
          {(notifDetailLoading || notifDetail) && (
            <div className="modal fade show d-block" style={{ background: 'rgba(0,0,0,0.5)' }} tabIndex={-1}>
              <div className="modal-dialog modal-lg modal-dialog-scrollable">
                <div className="modal-content">
                  <div className="modal-header">
                    <h5 className="modal-title">Dettaglio Notifica</h5>
                    <button type="button" className="btn-close" onClick={() => setNotifDetail(null)}></button>
                  </div>
                  <div className="modal-body">
                    {notifDetailLoading ? (
                      <div className="text-center text-muted py-4"><i className="fas fa-spinner fa-spin me-1"></i>Caricamento...</div>
                    ) : notifDetail && (
                      <>
                        <div className="mb-3">
                          <div><strong>Destinatario:</strong> {notifDetail.recipient.fullName || notifDetail.recipient.codiceFiscale} ({notifDetail.recipient.codiceFiscale})</div>
                          <div><strong>Campagna:</strong> {notifDetail.campaign.name} <span className="badge bg-light text-dark border ms-1">{notifDetail.campaign.channelType}</span></div>
                        </div>

                        <h6 className="fw-bold small">Storico Tentativi</h6>
                        <table className="table table-sm mb-4">
                          <thead><tr><th>#</th><th>Stato</th><th>Canale</th><th>Data</th><th>Errore</th><th>App IO</th></tr></thead>
                          <tbody>
                            {notifDetail.attempts.map((a) => (
                              <tr key={a.attemptNumber}>
                                <td>{a.attemptNumber}</td>
                                <td><span className="badge bg-light text-dark border">{a.status}</span></td>
                                <td className="small">{a.channelType}</td>
                                <td className="small text-muted">{new Date(a.createdAt).toLocaleString('it-IT')}</td>
                                <td className="small text-danger">{a.errorMessage || '—'}</td>
                                <td className="small">
                                  {a.appIo.attempted
                                    ? (a.appIo.success ? <span className="text-success">Consegnato</span> : <span className="text-danger">{a.appIo.error || 'Non consegnato'}</span>)
                                    : <span className="text-muted">Non tentato</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>

                        <h6 className="fw-bold small">Anteprima Messaggio Inviato</h6>
                        <div className="mb-2 small text-muted"><strong>Oggetto:</strong> {notifDetail.preview.subject}</div>
                        {notifDetail.preview.bodyHtml ? (
                          <div className="bg-white border rounded overflow-hidden" style={{ padding: '4px' }} dangerouslySetInnerHTML={{ __html: notifDetail.preview.bodyHtml }} />
                        ) : notifDetail.preview.bodyMarkdown ? (
                          <div className="bg-white border rounded p-3" data-color-mode="light">
                            <MDEditor.Markdown source={notifDetail.preview.bodyMarkdown} />
                          </div>
                        ) : (
                          <div className="text-muted small">Nessuna anteprima disponibile.</div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
```

- [ ] **Step 5: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 6: Verifica manuale nel browser**

Vai in "Ricerca Notifiche", cerca, clicca una riga: verifica che il modal si apra con storico tentativi e anteprima messaggio corretti. Verifica su una notifica con co-consegna App IO che la colonna "App IO" mostri l'esito corretto (Consegnato/Non consegnato/Non tentato).

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): maschera dettaglio notifica con storico tentativi e anteprima ricostruita"
```

---

### Task 7: Backend — entity `DownloadEvent` + migration

**Files:**
- Create: `apps/backend/src/entities/download-event.entity.ts`
- Create: `apps/backend/src/database/migrations/1783200000000-AddDownloadEvents.ts`
- Modify: `apps/backend/src/database/database.module.ts`

**Interfaces:**
- Produces: entity `DownloadEvent` con colonne `id, recipientId, channel, attachmentIndex, downloadedAt`, usata dai Task 8-10.

- [ ] **Step 1: Crea l'entity**

```ts
// apps/backend/src/entities/download-event.entity.ts
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Recipient } from './recipient.entity';

/**
 * Una riga per ogni download effettivo di un allegato, qualunque canale
 * (link firmato email/PEC/App IO, o portale cittadino autenticato). Fonte di
 * verità per le statistiche per canale — si aggiunge ai contatori esistenti
 * su Recipient/extraData, non li sostituisce (retrocompatibilità UI).
 */
@Entity('download_events')
export class DownloadEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'recipient_id' })
  recipientId!: string;

  @Column({ length: 20 })
  channel!: string;

  @Column({ name: 'attachment_index', default: 0 })
  attachmentIndex!: number;

  @CreateDateColumn({ name: 'downloaded_at' })
  downloadedAt!: Date;

  @ManyToOne('Recipient', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'recipient_id' })
  recipient!: Recipient;
}
```

- [ ] **Step 2: Crea la migration**

```ts
// apps/backend/src/database/migrations/1783200000000-AddDownloadEvents.ts
import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDownloadEvents1783200000000 implements MigrationInterface {
    name = 'AddDownloadEvents1783200000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "download_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "recipient_id" uuid NOT NULL, "channel" character varying(20) NOT NULL, "attachment_index" integer NOT NULL DEFAULT 0, "downloaded_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_download_events_id" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "download_events" ADD CONSTRAINT "FK_download_events_recipient" FOREIGN KEY ("recipient_id") REFERENCES "recipients"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "download_events" DROP CONSTRAINT "FK_download_events_recipient"`);
        await queryRunner.query(`DROP TABLE "download_events"`);
    }

}
```

- [ ] **Step 3: Registra la migration**

In `apps/backend/src/database/database.module.ts`, aggiungi l'import:

```ts
import { AddDownloadEvents1783200000000 } from './migrations/1783200000000-AddDownloadEvents';
```

E aggiungi `AddDownloadEvents1783200000000` in fondo all'array `migrations: [...]` esistente (dopo `FixRecipientCampaignJoin1783148719725`).

- [ ] **Step 4: Verifica che la migration giri pulita su un DB temporaneo**

```bash
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "CREATE DATABASE migration_test_download_events;"
PGPASS=$(docker compose exec postgres printenv POSTGRES_PASSWORD | tr -d '\r')
docker compose exec -e DATABASE_URL="postgresql://comunicapa:${PGPASS}@postgres:5432/migration_test_download_events" backend node_modules/.bin/typeorm-ts-node-commonjs migration:run -d src/database/data-source.ts
docker compose exec postgres psql -U comunicapa -d migration_test_download_events -c "\d download_events"
docker compose exec postgres psql -U comunicapa -d comunicapa_db -c "DROP DATABASE migration_test_download_events;"
```

Se `docker compose` collide con uno stack già attivo con lo stesso project name in questo ambiente, salta questo step di verifica live e procedi — la migration verrà comunque eseguita automaticamente all'avvio del backend (`migrationsRun` in `database.module.ts`) e la sua correttezza SQL è verificabile per lettura diretta.
Expected: la tabella esiste con le colonne attese.

- [ ] **Step 5: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/entities/download-event.entity.ts apps/backend/src/database/migrations/1783200000000-AddDownloadEvents.ts apps/backend/src/database/database.module.ts
git commit -m "feat(backend): entity e migration DownloadEvent per il tracking canale download"
```

---

### Task 8: Backend — canale nella firma del link e in `processTemplate`

**Files:**
- Modify: `apps/backend/src/channels/download-link.util.ts`
- Modify: `apps/backend/src/channels/template.helper.ts`
- Modify: `apps/backend/src/channels/email/email.strategy.ts`
- Modify: `apps/backend/src/channels/pec/pec.strategy.ts`
- Modify: `apps/backend/src/queue/notification.processor.ts`
- Test: `apps/backend/src/channels/download-link.util.spec.ts`
- Test: `apps/backend/src/channels/template.helper.spec.ts`

**Interfaces:**
- Produces: `signDownloadLink(recipientId, index, expiresAtUnix, secret, channel = '')`, `verifyDownloadLink(recipientId, index, expiresAtUnix, signature, secret, channel = '')`. `processTemplate(..., format = 'html', sourceChannel = '')` — nuovo parametro opzionale in coda, retrocompatibile con ogni chiamata esistente.

- [ ] **Step 1: Scrivi i test che falliscono per `download-link.util`**

Aggiungi in `apps/backend/src/channels/download-link.util.spec.ts`, dopo i test esistenti:

```ts
  it('una firma generata con canale EMAIL non è valida per canale APP_IO', () => {
    const sig = signDownloadLink('r-1', 0, exp, secret, 'EMAIL');
    expect(verifyDownloadLink('r-1', 0, exp, sig, secret, 'APP_IO')).toBe(false);
  });

  it('canale di default (nessun canale passato) resta retrocompatibile su entrambi i lati', () => {
    const sig = signDownloadLink('r-1', 0, exp, secret);
    expect(verifyDownloadLink('r-1', 0, exp, sig, secret)).toBe(true);
  });
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest download-link --maxWorkers=2`
Expected: FAIL sul primo nuovo test — oggi il canale non fa parte della firma, quindi `EMAIL` e `APP_IO` risultano equivalenti (`true` invece di `false`).

- [ ] **Step 3: Implementa il canale nella firma**

Sostituisci il contenuto di `apps/backend/src/channels/download-link.util.ts` con:

```ts
import { createHmac, timingSafeEqual } from 'crypto';

function computeSignature(recipientId: string, index: number, expiresAtUnix: number, secret: string, channel: string): string {
  return createHmac('sha256', secret).update(`${recipientId}:${index}:${expiresAtUnix}:${channel}`).digest('hex');
}

export function signDownloadLink(recipientId: string, index: number, expiresAtUnix: number, secret: string, channel = ''): string {
  return computeSignature(recipientId, index, expiresAtUnix, secret, channel);
}

export function verifyDownloadLink(
  recipientId: string,
  index: number,
  expiresAtUnix: number,
  signature: string,
  secret: string,
  channel = '',
): boolean {
  const expected = computeSignature(recipientId, index, expiresAtUnix, secret, channel);
  const expectedBuf = Buffer.from(expected, 'hex');
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest download-link --maxWorkers=2`
Expected: PASS su tutti i test del file (esistenti + nuovi — i test esistenti non passano mai un canale, usano il default `''` su entrambi i lati, quindi restano identici a prima).

- [ ] **Step 5: Scrivi il test che fallisce per `processTemplate`**

Aggiungi in `apps/backend/src/channels/template.helper.spec.ts`, dentro `describe('processTemplate — link firmato con indice allegato', ...)`:

```ts
  it('aggiunge &ch=EMAIL al link quando sourceChannel è passato', () => {
    const result = processTemplate('Scarica: %allegato1%', baseRecipient, 'http://api.test', secret, exp, ['Tassa'], 'html', 'EMAIL');
    expect(result).toContain('&ch=EMAIL');
  });

  it('senza sourceChannel il link non contiene &ch= (retrocompatibile)', () => {
    const result = processTemplate('Scarica: %allegato1%', baseRecipient, 'http://api.test', secret, exp, ['Tassa']);
    expect(result).not.toContain('&ch=');
  });
```

- [ ] **Step 6: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest template.helper --maxWorkers=2`
Expected: FAIL sul primo nuovo test — `processTemplate` non accetta ancora `sourceChannel` (verrebbe ignorato come argomento in eccesso da TypeScript/JS, il link non conterrebbe `&ch=EMAIL`).

- [ ] **Step 7: Implementa `sourceChannel` in `processTemplate`**

In `apps/backend/src/channels/template.helper.ts`, modifica la firma e `buildDownloadUrl`:

```ts
export function processTemplate(
  bodyTemplate: string,
  recipient: Recipient,
  publicApiUrl: string,
  downloadLinkSecret: string,
  expiresAtUnix: number,
  attachmentLabels: string[] = [],
  format: 'html' | 'markdown' = 'html',
  sourceChannel = '',
): string {
  let content = bodyTemplate;

  const buildDownloadUrl = (index: number): string => {
    const sig = signDownloadLink(recipient.id, index, expiresAtUnix, downloadLinkSecret, sourceChannel);
    const chParam = sourceChannel ? `&ch=${encodeURIComponent(sourceChannel)}` : '';
    return `${publicApiUrl}/public/download/${recipient.id}/${index}?exp=${expiresAtUnix}&sig=${sig}${chParam}`;
  };
```

(Il resto della funzione resta invariato — solo la firma e `buildDownloadUrl` cambiano.)

- [ ] **Step 8: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest template.helper --maxWorkers=2`
Expected: PASS su tutti i test del file.

- [ ] **Step 9: Passa il canale reale dai chiamanti di produzione**

In `apps/backend/src/channels/email/email.strategy.ts`, sostituisci:

```ts
    const subject = processTemplate(subjectTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels);
    const bodyText = processTemplate(bodyTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels);
```

con:

```ts
    const subject = processTemplate(subjectTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, 'html', 'EMAIL');
    const bodyText = processTemplate(bodyTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, 'html', 'EMAIL');
```

In `apps/backend/src/channels/pec/pec.strategy.ts` (righe 51-52), sostituisci:

```ts
    const subject = processTemplate(subjectTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels);
    const bodyText = processTemplate(bodyTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels);
```

con:

```ts
    const subject = processTemplate(subjectTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, 'html', 'PEC');
    const bodyText = processTemplate(bodyTemplate, recipient, publicApiUrl, downloadLinkSecret, expiresAtUnix, attachmentLabels, 'html', 'PEC');
```

In `apps/backend/src/queue/notification.processor.ts`, dentro `sendAppIoMessage()`, sostituisci:

```ts
      const processedSubject = processTemplate(
        appIoConfig.subjectOverride || (campaign.channelConfig?.['subject'] as string) || campaign.name,
        recipient,
        publicApiUrl,
        downloadLinkSecret,
        expiresAtUnix,
        attachmentLabels,
      );
      const processedMarkdown = processTemplate(
        appIoConfig.bodyOverride || (campaign.channelConfig?.['body'] as string) || '',
        recipient,
        publicApiUrl,
        downloadLinkSecret,
        expiresAtUnix,
        attachmentLabels,
        'markdown',
      );
```

con:

```ts
      const processedSubject = processTemplate(
        appIoConfig.subjectOverride || (campaign.channelConfig?.['subject'] as string) || campaign.name,
        recipient,
        publicApiUrl,
        downloadLinkSecret,
        expiresAtUnix,
        attachmentLabels,
        'html',
        'APP_IO',
      );
      const processedMarkdown = processTemplate(
        appIoConfig.bodyOverride || (campaign.channelConfig?.['body'] as string) || '',
        recipient,
        publicApiUrl,
        downloadLinkSecret,
        expiresAtUnix,
        attachmentLabels,
        'markdown',
        'APP_IO',
      );
```

- [ ] **Step 10: Suite completa e type-check**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` e `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: tutti i test passano (baseline + nuovi), nessun errore di tipo.

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/channels/download-link.util.ts apps/backend/src/channels/download-link.util.spec.ts apps/backend/src/channels/template.helper.ts apps/backend/src/channels/template.helper.spec.ts apps/backend/src/channels/email/email.strategy.ts apps/backend/src/channels/pec/pec.strategy.ts apps/backend/src/queue/notification.processor.ts
git commit -m "feat(backend): il canale di invio entra nella firma del link di download"
```

---

### Task 9: Backend — registra `DownloadEvent` su ogni download reale (link pubblico + portale cittadino)

**Files:**
- Modify: `apps/backend/src/public-download/public-download.controller.ts`
- Modify: `apps/backend/src/public-download/public-download.module.ts`
- Modify: `apps/backend/src/citizen/citizen.service.ts`
- Modify: `apps/backend/src/citizen/citizen.module.ts`
- Test: `apps/backend/src/public-download/public-download.controller.spec.ts`
- Create: `apps/backend/src/citizen/citizen.service.spec.ts`

**Interfaces:**
- Consumes: entity `DownloadEvent` (Task 7), `verifyDownloadLink(..., channel)` (Task 8).

- [ ] **Step 1: Aggiorna i test esistenti di `public-download.controller.spec.ts` per la nuova firma**

Sostituisci l'intero contenuto di `apps/backend/src/public-download/public-download.controller.spec.ts` con:

```ts
import { Test } from '@nestjs/testing';
import { GoneException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PublicDownloadController } from './public-download.controller';
import { AttachmentService } from '../attachments/attachment.service';
import { Recipient } from '../entities/recipient.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { signDownloadLink } from '../channels/download-link.util';

describe('PublicDownloadController', () => {
  let controller: PublicDownloadController;
  const secret = 'test-secret';
  const recipientId = 'r-1';
  const futureExp = Math.floor(Date.now() / 1000) + 3600;

  const mockRecipient = {
    id: recipientId,
    attachmentDeletedAt: null,
    downloadCount: 0,
    firstDownloadedAt: null,
    lastDownloadedAt: null,
    campaign: { channelConfig: {} },
    extraData: {},
  };

  const mockRepo = {
    findOne: jest.fn().mockResolvedValue(mockRecipient),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const mockAttachmentService = {
    generatePdfBuffer: jest.fn().mockResolvedValue(Buffer.from('%PDF-fake')),
  };
  const mockDownloadEventRepo = {
    insert: jest.fn().mockResolvedValue(undefined),
  };
  const mockConfig = { get: () => secret };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRepo.findOne.mockResolvedValue(mockRecipient);
    const module = await Test.createTestingModule({
      controllers: [PublicDownloadController],
      providers: [
        { provide: getRepositoryToken(Recipient), useValue: mockRepo },
        { provide: getRepositoryToken(DownloadEvent), useValue: mockDownloadEventRepo },
        { provide: AttachmentService, useValue: mockAttachmentService },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    controller = module.get(PublicDownloadController);
  });

  it('rifiuta con 403 se la firma non è valida', async () => {
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(
      controller.download(recipientId, '0', String(futureExp), 'firma-non-valida', undefined, res),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rifiuta con 403 se l\'indice non corrisponde alla firma (firma dell\'indice 0 usata per l\'indice 1)', async () => {
    const sig = signDownloadLink(recipientId, 0, futureExp, secret);
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(
      controller.download(recipientId, '1', String(futureExp), sig, undefined, res),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rifiuta con 403 se il canale non corrisponde alla firma', async () => {
    const sig = signDownloadLink(recipientId, 0, futureExp, secret, 'EMAIL');
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(
      controller.download(recipientId, '0', String(futureExp), sig, 'APP_IO', res),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rifiuta con 410 se il link è scaduto', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 10;
    const sig = signDownloadLink(recipientId, 0, pastExp, secret);
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(controller.download(recipientId, '0', String(pastExp), sig, undefined, res)).rejects.toThrow(GoneException);
  });

  it('rifiuta con 410 se l\'allegato è già stato eliminato per retention', async () => {
    mockRepo.findOne.mockResolvedValueOnce({ ...mockRecipient, attachmentDeletedAt: new Date() });
    const sig = signDownloadLink(recipientId, 0, futureExp, secret);
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await expect(controller.download(recipientId, '0', String(futureExp), sig, undefined, res)).rejects.toThrow(GoneException);
  });

  it('serve il PDF, incrementa downloadCount e registra un DownloadEvent col canale corretto', async () => {
    const sig = signDownloadLink(recipientId, 1, futureExp, secret, 'EMAIL');
    const res: any = { setHeader: jest.fn(), end: jest.fn() };
    await controller.download(recipientId, '1', String(futureExp), sig, 'EMAIL', res);
    expect(mockAttachmentService.generatePdfBuffer).toHaveBeenCalledWith(mockRecipient, 1);
    expect(res.end).toHaveBeenCalledWith(Buffer.from('%PDF-fake'));
    expect(mockRepo.update).toHaveBeenCalledWith(
      recipientId,
      expect.objectContaining({ downloadCount: 1 }),
    );
    expect(mockDownloadEventRepo.insert).toHaveBeenCalledWith({
      recipientId,
      channel: 'EMAIL',
      attachmentIndex: 1,
    });
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest public-download --maxWorkers=2`
Expected: FAIL — il controller non ha ancora il parametro `channel` né inserisce `DownloadEvent`.

- [ ] **Step 3: Implementa il controller**

Sostituisci l'intero contenuto di `apps/backend/src/public-download/public-download.controller.ts` con:

```ts
import { Controller, ForbiddenException, Get, GoneException, Param, Query, Res } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { AppConfiguration } from '../config/configuration';
import { Public } from '../auth/decorators/public.decorator';
import { Recipient } from '../entities/recipient.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { AttachmentService } from '../attachments/attachment.service';
import { verifyDownloadLink } from '../channels/download-link.util';

@Controller('public/download')
@Public()
export class PublicDownloadController {
  constructor(
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(DownloadEvent)
    private readonly downloadEventRepo: Repository<DownloadEvent>,
    private readonly attachmentService: AttachmentService,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}

  @Get(':recipientId/:index')
  async download(
    @Param('recipientId') recipientId: string,
    @Param('index') indexParam: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Query('ch') channel: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const index = parseInt(indexParam, 10);
    const expiresAtUnix = parseInt(exp, 10);
    const secret = this.config.get('downloadLink.secret', { infer: true });

    if (
      !Number.isFinite(index) ||
      index < 0 ||
      !Number.isFinite(expiresAtUnix) ||
      !verifyDownloadLink(recipientId, index, expiresAtUnix, sig, secret, channel ?? '')
    ) {
      throw new ForbiddenException('Link non valido');
    }
    if (Math.floor(Date.now() / 1000) > expiresAtUnix) {
      throw new GoneException('Link scaduto');
    }

    const recipient = await this.recipientRepo.findOne({
      where: { id: recipientId },
      relations: ['campaign'],
    });
    if (!recipient || recipient.attachmentDeletedAt) {
      throw new GoneException('Allegato non più disponibile');
    }

    const pdfBuffer = await this.attachmentService.generatePdfBuffer(recipient, index);

    await this.recipientRepo.update(recipientId, {
      downloadCount: recipient.downloadCount + 1,
      firstDownloadedAt: recipient.firstDownloadedAt ?? new Date(),
      lastDownloadedAt: new Date(),
    });
    await this.downloadEventRepo.insert({
      recipientId,
      channel: channel || 'UNKNOWN',
      attachmentIndex: index,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="avviso_${recipientId.slice(0, 8)}_${index + 1}.pdf"`);
    res.end(pdfBuffer);
  }
}
```

- [ ] **Step 4: Registra `DownloadEvent` nel modulo**

In `apps/backend/src/public-download/public-download.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Recipient } from '../entities/recipient.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { AttachmentModule } from '../attachments/attachment.module';
import { PublicDownloadController } from './public-download.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Recipient, DownloadEvent]), AttachmentModule],
  controllers: [PublicDownloadController],
})
export class PublicDownloadModule {}
```

- [ ] **Step 5: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest public-download --maxWorkers=2`
Expected: PASS su tutti i test.

- [ ] **Step 6: Scrivi il test che fallisce per `citizen.service.ts`**

```ts
// apps/backend/src/citizen/citizen.service.spec.ts
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CitizenService } from './citizen.service';
import { Recipient } from '../entities/recipient.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { AttachmentService } from '../attachments/attachment.service';

describe('CitizenService.markAsDownloaded', () => {
  const mockRecipient = { id: 'r-1', codiceFiscale: 'RSSMRA80A01H501X', extraData: {} };
  const mockRecipientRepo = {
    findOne: jest.fn().mockResolvedValue(mockRecipient),
    save: jest.fn().mockImplementation((r) => Promise.resolve(r)),
  };
  const mockDownloadEventRepo = { insert: jest.fn().mockResolvedValue(undefined) };
  const mockAttachmentService = { generatePdfBuffer: jest.fn() };

  let service: CitizenService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRecipientRepo.findOne.mockResolvedValue({ ...mockRecipient, extraData: {} });
    const moduleRef = await Test.createTestingModule({
      providers: [
        CitizenService,
        { provide: getRepositoryToken(Recipient), useValue: mockRecipientRepo },
        { provide: getRepositoryToken(DownloadEvent), useValue: mockDownloadEventRepo },
        { provide: AttachmentService, useValue: mockAttachmentService },
      ],
    }).compile();
    service = moduleRef.get(CitizenService);
  });

  it('incrementa extraData.download_count come prima E registra un DownloadEvent CITIZEN_PORTAL', async () => {
    await service.markAsDownloaded('r-1', 'RSSMRA80A01H501X');

    expect(mockRecipientRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ extraData: expect.objectContaining({ download_count: 1 }) }),
    );
    expect(mockDownloadEventRepo.insert).toHaveBeenCalledWith({
      recipientId: 'r-1',
      channel: 'CITIZEN_PORTAL',
      attachmentIndex: 0,
    });
  });
});
```

- [ ] **Step 7: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest citizen.service --maxWorkers=2`
Expected: FAIL — `CitizenService` non ha ancora `DownloadEvent` iniettato, il test fallisce nella creazione del `TestingModule` o l'insert non avviene.

- [ ] **Step 8: Implementa in `citizen.service.ts`**

Aggiungi l'import in cima:

```ts
import { DownloadEvent } from '../entities/download-event.entity';
```

Aggiorna il costruttore:

```ts
  constructor(
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(DownloadEvent)
    private readonly downloadEventRepo: Repository<DownloadEvent>,
    private readonly attachmentService: AttachmentService,
  ) {}
```

Aggiorna `markAsDownloaded`:

```ts
  async markAsDownloaded(id: string, codiceFiscale: string): Promise<Recipient> {
    const recipient = await this.findOneForCitizen(id, codiceFiscale);

    if (!recipient.extraData) {
      recipient.extraData = {};
    }

    const currentCount = Number(recipient.extraData['download_count'] ?? 0);
    recipient.extraData['download_count'] = currentCount + 1;
    recipient.extraData['downloaded_at'] = new Date().toISOString();

    await this.recipientRepo.save(recipient);
    await this.downloadEventRepo.insert({ recipientId: id, channel: 'CITIZEN_PORTAL', attachmentIndex: 0 });
    return recipient;
  }
```

- [ ] **Step 9: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest citizen.service --maxWorkers=2`
Expected: PASS.

- [ ] **Step 10: Registra `DownloadEvent` nel modulo cittadino**

In `apps/backend/src/citizen/citizen.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Recipient } from '../entities/recipient.entity';
import { Campaign } from '../entities/campaign.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { CitizenController } from './citizen.controller';
import { CitizenService } from './citizen.service';
import { AuthModule } from '../auth/auth.module';
import { AttachmentModule } from '../attachments/attachment.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Recipient, Campaign, NotificationAttempt, DownloadEvent]),
    AuthModule,
    AttachmentModule,
  ],
  controllers: [CitizenController],
  providers: [CitizenService],
  exports: [CitizenService],
})
export class CitizenModule {}
```

- [ ] **Step 11: Suite completa e type-check**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` e `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: tutti i test passano, nessun errore di tipo.

- [ ] **Step 12: Commit**

```bash
git add apps/backend/src/public-download/public-download.controller.ts apps/backend/src/public-download/public-download.module.ts apps/backend/src/public-download/public-download.controller.spec.ts apps/backend/src/citizen/citizen.service.ts apps/backend/src/citizen/citizen.module.ts apps/backend/src/citizen/citizen.service.spec.ts
git commit -m "feat(backend): registra DownloadEvent su ogni download reale, incluso il portale cittadino"
```

---

### Task 10: Backend — statistiche download per canale + campo nel dettaglio notifica

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.module.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Modify: `apps/backend/src/notifications-search/dto/notification-detail.dto.ts`
- Modify: `apps/backend/src/notifications-search/notifications-search.service.ts`
- Modify: `apps/backend/src/notifications-search/notifications-search.module.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`
- Test: `apps/backend/src/notifications-search/notifications-search.service.spec.ts`

**Interfaces:**
- Produces: `CampaignsService.getDownloadChannelStats(campaignId): Promise<Record<string, number>>`. Route `GET /admin/campaigns/:id/download-channel-stats` → `{campaignId, byChannel: Record<string, number>}`. `NotificationDetailDto.downloads: Array<{channel: string; attachmentIndex: number; downloadedAt: string}>`.

- [ ] **Step 1: Scrivi il test che fallisce per `getDownloadChannelStats`**

Aggiungi in `apps/backend/src/campaigns/campaigns.service.spec.ts`:

```ts
  describe('getDownloadChannelStats', () => {
    it('raggruppa i DownloadEvent per canale', async () => {
      const qbMock = {
        innerJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { channel: 'EMAIL', count: '3' },
          { channel: 'CITIZEN_PORTAL', count: '1' },
        ]),
      };
      mockDownloadEventRepo.createQueryBuilder = jest.fn().mockReturnValue(qbMock);

      const result = await service.getDownloadChannelStats('uuid-1');

      expect(result).toEqual({ EMAIL: 3, CITIZEN_PORTAL: 1 });
      expect(qbMock.where).toHaveBeenCalledWith('r.campaignId = :campaignId', { campaignId: 'uuid-1' });
    });
  });
```

Aggiungi `mockDownloadEventRepo = { createQueryBuilder: jest.fn() }` tra le dichiarazioni dei mock repo in cima al file (accanto a `mockCampaignRepo`/`mockRecipientRepo`), e aggiungi `{ provide: getRepositoryToken(DownloadEvent), useValue: mockDownloadEventRepo }` all'array `providers` del `TestingModule.createTestingModule` nel `beforeEach` esistente. Aggiungi l'import `import { DownloadEvent } from '../entities/download-event.entity';` in cima al file.

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "getDownloadChannelStats" --maxWorkers=2`
Expected: FAIL — `getDownloadChannelStats is not a function`.

- [ ] **Step 3: Implementa il metodo**

In `apps/backend/src/campaigns/campaigns.service.ts`, aggiungi l'import:

```ts
import { DownloadEvent } from '../entities/download-event.entity';
```

Aggiungi il repository al costruttore:

```ts
  constructor(
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(DownloadEvent)
    private readonly downloadEventRepo: Repository<DownloadEvent>,
    private readonly notificationQueues: NotificationQueuesService,
    private readonly settings: AppSettingsService,
    private readonly config: ConfigService<AppConfiguration, true>,
  ) {}
```

Aggiungi il metodo, dopo `getChannelBreakdown`:

```ts
  async getDownloadChannelStats(campaignId: string): Promise<Record<string, number>> {
    const rows = await this.downloadEventRepo
      .createQueryBuilder('de')
      .innerJoin('de.recipient', 'r')
      .select('de.channel', 'channel')
      .addSelect('COUNT(*)', 'count')
      .where('r.campaignId = :campaignId', { campaignId })
      .groupBy('de.channel')
      .getRawMany<{ channel: string; count: string }>();

    const byChannel: Record<string, number> = {};
    for (const row of rows) {
      byChannel[row.channel] = parseInt(row.count, 10);
    }
    return byChannel;
  }
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker compose exec backend node_modules/.bin/jest campaigns.service -t "getDownloadChannelStats" --maxWorkers=2`
Expected: PASS.

- [ ] **Step 5: Registra `DownloadEvent` nel modulo campagne**

In `apps/backend/src/campaigns/campaigns.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Campaign } from '../entities/campaign.entity';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { QueueModule } from '../queue/queue.module';
import { CampaignsService } from './campaigns.service';
import { CampaignsController } from './campaigns.controller';
import { RetentionCleanupService } from './retention-cleanup.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Campaign, Recipient, NotificationAttempt, DownloadEvent]),
    QueueModule,
  ],
  providers: [CampaignsService, RetentionCleanupService],
  controllers: [CampaignsController],
  exports: [CampaignsService],
})
export class CampaignsModule {}
```

- [ ] **Step 6: Aggiungi la route**

In `apps/backend/src/campaigns/campaigns.controller.ts`, dopo `getChannelBreakdown`:

```ts
  @Get(':id/download-channel-stats')
  async getDownloadChannelStats(@Param('id', ParseUUIDPipe) id: string) {
    const byChannel = await this.campaignsService.getDownloadChannelStats(id);
    return { campaignId: id, byChannel };
  }
```

- [ ] **Step 7: Aggiungi `downloads` al dettaglio notifica**

In `apps/backend/src/notifications-search/dto/notification-detail.dto.ts`, aggiungi al `NotificationDetailDto`:

```ts
export interface NotificationDetailDto {
  recipient: {
    id: string;
    codiceFiscale: string;
    fullName: string | null;
    email: string | null;
    pec: string | null;
    status: string;
  };
  campaign: {
    id: string;
    name: string;
    channelType: string;
  };
  attempts: AttemptDetailDto[];
  downloads: Array<{ channel: string; attachmentIndex: number; downloadedAt: string }>;
  preview: PreviewMessageResult;
}
```

In `apps/backend/src/notifications-search/notifications-search.service.ts`, aggiungi l'import `DownloadEvent` e il repository al costruttore:

```ts
import { DownloadEvent } from '../entities/download-event.entity';
```

```ts
  constructor(
    @InjectRepository(Recipient)
    private readonly recipientRepo: Repository<Recipient>,
    @InjectRepository(NotificationAttempt)
    private readonly attemptRepo: Repository<NotificationAttempt>,
    @InjectRepository(DownloadEvent)
    private readonly downloadEventRepo: Repository<DownloadEvent>,
    private readonly campaignsService: CampaignsService,
  ) {}
```

In `getDetail()`, aggiungi il fetch e il campo nel ritorno:

```ts
    const downloads = await this.downloadEventRepo.find({
      where: { recipientId },
      order: { downloadedAt: 'ASC' },
    });
```

E nell'oggetto ritornato, subito prima di `preview,`:

```ts
      downloads: downloads.map((d) => ({
        channel: d.channel,
        attachmentIndex: d.attachmentIndex,
        downloadedAt: d.downloadedAt.toISOString(),
      })),
```

- [ ] **Step 8: Aggiorna il test esistente di `getDetail`**

Nel test `'ritorna destinatario, campagna, tentativi ed esito App IO separato'` (Task 5, Step 6), aggiungi `attemptRepoMock`/nuovo mock repo per `DownloadEvent` all'array providers del `beforeEach` (`{ provide: getRepositoryToken(DownloadEvent), useValue: downloadEventRepoMock }`, con `downloadEventRepoMock = { find: jest.fn() }` dichiarato accanto agli altri mock), imposta `downloadEventRepoMock.find.mockResolvedValueOnce([{ channel: 'EMAIL', attachmentIndex: 0, downloadedAt: new Date('2026-07-02T08:00:00Z') }])` prima della chiamata a `service.getDetail('r1')`, e aggiungi al risultato atteso, prima di `preview: ...`:

```ts
      downloads: [{ channel: 'EMAIL', attachmentIndex: 0, downloadedAt: '2026-07-02T08:00:00.000Z' }],
```

- [ ] **Step 9: Aggiorna il modulo notifications-search**

In `apps/backend/src/notifications-search/notifications-search.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Recipient } from '../entities/recipient.entity';
import { NotificationAttempt } from '../entities/notification-attempt.entity';
import { DownloadEvent } from '../entities/download-event.entity';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { NotificationsSearchService } from './notifications-search.service';
import { NotificationsSearchController } from './notifications-search.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Recipient, NotificationAttempt, DownloadEvent]), CampaignsModule],
  controllers: [NotificationsSearchController],
  providers: [NotificationsSearchService],
})
export class NotificationsSearchModule {}
```

- [ ] **Step 10: Suite completa e type-check**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` e `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: tutti i test passano, nessun errore di tipo.

- [ ] **Step 11: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.module.ts apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/notifications-search/dto/notification-detail.dto.ts apps/backend/src/notifications-search/notifications-search.service.ts apps/backend/src/notifications-search/notifications-search.module.ts apps/backend/src/campaigns/campaigns.service.spec.ts apps/backend/src/notifications-search/notifications-search.service.spec.ts
git commit -m "feat(backend): statistiche download per canale e dettaglio download nella maschera notifica"
```

---

### Task 11: Frontend — mostra il download per canale (dettaglio campagna + dettaglio notifica)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `GET ${ADMIN_API_BASE}/campaigns/:id/channel-stats` → aggiungi anche `GET ${ADMIN_API_BASE}/campaigns/:id/download-channel-stats` (Task 10), risposta `{campaignId, byChannel: Record<string, number>}`. Campo `downloads` in `NotificationDetailDto` (Task 10).

- [ ] **Step 1: Aggiungi lo state e il fetch nel dettaglio campagna**

Vicino a `channelBreakdown` (Task 2, Step 1), aggiungi:

```tsx
  const [downloadByChannel, setDownloadByChannel] = useState<Record<string, number> | null>(null);
```

In `fetchChannelBreakdown` (Task 2, Step 2) o come funzione gemella, aggiungi subito dopo la sua definizione:

```tsx
  const fetchDownloadChannelStats = async (id: string) => {
    try {
      const res = await apiFetch(`/campaigns/${id}/download-channel-stats`);
      if (!res.ok) return;
      const data = await res.json();
      setDownloadByChannel(data.byChannel && Object.keys(data.byChannel).length > 0 ? data.byChannel : null);
    } catch {
      // Non bloccante.
    }
  };
```

E nel `handleCampaignClick` (già modificato nel Task 2, Step 2), aggiungi `setDownloadByChannel(null);` accanto a `setChannelBreakdown(null);` e `fetchDownloadChannelStats(id);` accanto a `fetchChannelBreakdown(id);`.

- [ ] **Step 2: Renderizza il blocco nel dettaglio campagna**

Subito dopo il blocco "Dettaglio Consegna Multicanale" (Task 2, Step 3), aggiungi:

```tsx
                        {downloadByChannel && (
                          <div className="mt-4 border-top pt-3">
                            <h4 className="small fw-bold mb-2">
                              <i className="fas fa-download me-1 text-primary"></i>Download per Canale
                            </h4>
                            <div className="small">
                              {Object.entries(downloadByChannel).map(([channel, count]) => (
                                <div key={channel} className="d-flex justify-content-between mb-1">
                                  <span>{channel}</span>
                                  <span className="fw-bold">{count}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
```

- [ ] **Step 3: Aggiungi la sezione download nel modal dettaglio notifica**

Nel tipo di `notifDetail` (Task 6, Step 1), aggiungi il campo `downloads`:

```tsx
    downloads: Array<{ channel: string; attachmentIndex: number; downloadedAt: string }>;
```

Nel modal (Task 6, Step 4), subito dopo la tabella "Storico Tentativi" e prima di "Anteprima Messaggio Inviato", aggiungi:

```tsx
                        {notifDetail.downloads.length > 0 && (
                          <>
                            <h6 className="fw-bold small">Download</h6>
                            <table className="table table-sm mb-4">
                              <thead><tr><th>Canale</th><th>Allegato</th><th>Data</th></tr></thead>
                              <tbody>
                                {notifDetail.downloads.map((d, idx) => (
                                  <tr key={idx}>
                                    <td className="small">{d.channel}</td>
                                    <td className="small">#{d.attachmentIndex + 1}</td>
                                    <td className="small text-muted">{new Date(d.downloadedAt).toLocaleString('it-IT')}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </>
                        )}
```

- [ ] **Step 4: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 5: Verifica manuale nel browser**

Scarica un allegato da un link email e uno da link App IO (o simula) di una stessa campagna: verifica che "Download per Canale" nel dettaglio campagna mostri il conteggio corretto per canale. Apri il dettaglio notifica di un destinatario che ha scaricato: verifica la tabella "Download" col canale corretto.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): mostra download per canale in dettaglio campagna e dettaglio notifica"
```
