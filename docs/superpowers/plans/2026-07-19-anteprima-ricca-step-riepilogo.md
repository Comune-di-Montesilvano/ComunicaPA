# Anteprima Ricca Step "Anteprima e Invio" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lo step 6 del wizard campagne ("Anteprima e Invio") oggi mostra solo un riepilogo statico. Questo piano lo arricchisce con l'anteprima reale già usata allo step 4 (per EMAIL/PEC/APP_IO) e un nuovo pannello indirizzo+allegato per SEND/POSTAL, entrambi con sfoglia destinatari e anteprima PDF inline dell'allegato configurato (se PDF; altrimenti solo download).

**Architettura:** Estrazione del pannello anteprima esistente di step4 in un componente `WizRecipientPreviewPanel` riusato identico in step6 per EMAIL/PEC/APP_IO (stesso stato `wizPreviewIndex`, stesso effect di rendering, solo la guardia dell'effect estesa a `wizStep===6`). Nuovo componente `WizAttachmentInlinePreview` (fetch autenticato standard → Blob → Object URL → `<embed>` se PDF, altrimenti solo link download) riusato sia nel pannello EMAIL/PEC/APP_IO sia in un nuovo pannello `WizAddressAttachmentPreviewPanel` per SEND/POSTAL (indirizzo + allegato). Nuovo endpoint backend `GET /admin/campaigns/:id/attachments/preview-file` che serve un file già caricato in `uploads/<campaignId>/` per nome esatto (whitelist contro `fs.readdirSync`, nessuna costruzione di path da input utente), dietro il guard JWT standard — nessun meccanismo di link firmato, il frontend consuma la risposta come Blob via fetch autenticato.

**Tech Stack:** NestJS 10 + TypeScript (backend), React 19 + TypeScript (frontend-admin), Jest.

## Global Constraints

- Spec di riferimento: `docs/superpowers/specs/2026-07-19-anteprima-ricca-step-riepilogo-design.md`.
- Nessun meccanismo di link firmato/token in query string — l'endpoint resta dietro il guard `@Roles` standard, il frontend usa `fetch()` con header `Authorization: Bearer` (pattern esistente) e trasforma la risposta in `Blob`/Object URL locale.
- Indirizzo SEND/POSTAL sempre tutti e 4 i campi obbligatori (nessun fallback "risolto da PN") — la validazione esistente al passo 3 li garantisce già mappati e non vuoti su ogni riga valida.
- L'anteprima allegato inline si applica a TUTTI i canali quando la campagna ha allegati configurati (`wizAttachments.length > 0`), non solo SEND/POSTAL. Multi-allegato: itera su tutti gli elementi di `wizAttachments`, un blocco anteprima per ciascuno (non solo il primo).
- Embed PDF inline solo se il filename atteso termina in `.pdf` (case-insensitive); altrimenti solo link "Scarica".
- `docker compose exec backend node_modules/.bin/jest --maxWorkers=2` per i test backend (o pattern `docker run` equivalente da worktree, vedi task).
- `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` per il frontend — nessuna suite unit test frontend in questo repo, verifica manuale in browser richiesta per ogni task frontend.

---

### Task 1: Backend — endpoint download allegato bozza

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts`
- Test: `apps/backend/src/campaigns/campaigns.service.spec.ts`

**Interfaces:**
- Produces: `CampaignsService.resolveAttachmentPreviewFilePath(campaignId: string, filename: string): Promise<{ path: string; contentType: string }>` — valida esistenza campagna + whitelist filename, lancia `NotFoundException` se non presente. Endpoint `GET /admin/campaigns/:id/attachments/preview-file?filename=<nome>`.
- Consumes: `getUploadsDir` (esistente, `attachment-paths.ts`), `fs.readdirSync`/`fs.existsSync` (già importati come `* as fs` in `campaigns.service.ts`).

- [ ] **Step 1: Scrivi il test (fallisce: metodo non esiste)**

Verifica prima il pattern di mock già usato in `campaigns.service.spec.ts` per test che toccano `fs`/`getUploadsDir` (cerca test esistenti su `finalizeAttachments`/`findMissingAttachments` per il pattern di mock del filesystem reale — questo file usa directory temporanee reali via `fs.mkdtempSync`, non mock di `fs`). Aggiungi:

```ts
  describe('resolveAttachmentPreviewFilePath', () => {
    it('risolve il path se il file esiste nella cartella upload della campagna', async () => {
      const tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'preview-file-'));
      process.env['ATTACHMENTS_PATH'] = tmpDir;
      const campaignId = 'campaign-1';
      const uploadsDir = join(tmpDir, 'uploads', campaignId);
      fs.mkdirSync(uploadsDir, { recursive: true });
      fs.writeFileSync(join(uploadsDir, 'avviso.pdf'), '%PDF-1.4 test');
      mockCampaignRepo.existsBy.mockResolvedValue(true);

      const result = await service.resolveAttachmentPreviewFilePath(campaignId, 'avviso.pdf');

      expect(result.path).toBe(join(uploadsDir, 'avviso.pdf'));
      expect(result.contentType).toBe('application/pdf');

      fs.rmSync(tmpDir, { recursive: true, force: true });
      delete process.env['ATTACHMENTS_PATH'];
    });

    it('lancia NotFoundException se il filename non è tra i file presenti (whitelist)', async () => {
      const tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'preview-file-'));
      process.env['ATTACHMENTS_PATH'] = tmpDir;
      const campaignId = 'campaign-2';
      const uploadsDir = join(tmpDir, 'uploads', campaignId);
      fs.mkdirSync(uploadsDir, { recursive: true });
      fs.writeFileSync(join(uploadsDir, 'reale.pdf'), '%PDF-1.4 test');
      mockCampaignRepo.existsBy.mockResolvedValue(true);

      await expect(service.resolveAttachmentPreviewFilePath(campaignId, '../../../etc/passwd'))
        .rejects.toThrow(NotFoundException);
      await expect(service.resolveAttachmentPreviewFilePath(campaignId, 'non-esiste.pdf'))
        .rejects.toThrow(NotFoundException);

      fs.rmSync(tmpDir, { recursive: true, force: true });
      delete process.env['ATTACHMENTS_PATH'];
    });

    it('lancia NotFoundException se la campagna non esiste', async () => {
      mockCampaignRepo.existsBy.mockResolvedValue(false);
      await expect(service.resolveAttachmentPreviewFilePath('inesistente', 'x.pdf'))
        .rejects.toThrow(NotFoundException);
    });

    it('usa Content-Type octet-stream per estensioni non-pdf', async () => {
      const tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'preview-file-'));
      process.env['ATTACHMENTS_PATH'] = tmpDir;
      const campaignId = 'campaign-3';
      const uploadsDir = join(tmpDir, 'uploads', campaignId);
      fs.mkdirSync(uploadsDir, { recursive: true });
      fs.writeFileSync(join(uploadsDir, 'dati.zip'), 'PK...');
      mockCampaignRepo.existsBy.mockResolvedValue(true);

      const result = await service.resolveAttachmentPreviewFilePath(campaignId, 'dati.zip');
      expect(result.contentType).toBe('application/octet-stream');

      fs.rmSync(tmpDir, { recursive: true, force: true });
      delete process.env['ATTACHMENTS_PATH'];
    });
  });
```

Verifica se `os` e `join` sono già importati in cima al file di test (`campaigns.service.spec.ts`); se `os` manca, aggiungi `import * as os from 'os';`.

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `docker run --rm -v "$(pwd)/apps/backend/src:/app/apps/backend/src" -v "$(pwd)/packages/shared-types/src:/app/packages/shared-types/src" -v comunicapa_backend_node_modules:/app/node_modules -w /app/apps/backend comunicapa/backend:dev node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: FAIL — `service.resolveAttachmentPreviewFilePath is not a function`.

- [ ] **Step 3: Implementa il metodo**

Aggiungi in `apps/backend/src/campaigns/campaigns.service.ts`, vicino agli altri metodi che leggono `getUploadsDir` (es. subito dopo `checkAttachmentsBlocking` o `findMissingAttachments`):

```ts
  async resolveAttachmentPreviewFilePath(
    campaignId: string,
    filename: string,
  ): Promise<{ path: string; contentType: string }> {
    const exists = await this.campaignRepo.existsBy({ id: campaignId });
    if (!exists) throw new NotFoundException(`Campaign ${campaignId} not found`);

    const dir = getUploadsDir(campaignId);
    const present = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    // Whitelist stretta: il confronto è per uguaglianza di stringa contro
    // l'elenco reale dei file presenti, mai costruzione di path da input
    // utente — previene path traversal senza bisogno di sanitizzare `filename`.
    if (!present.includes(filename)) {
      throw new NotFoundException('Allegato non trovato — verifica il Passo 5');
    }

    const contentType = filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
    return { path: join(dir, filename), contentType };
  }
```

`join` e `fs` sono già importati in cima al file (usati da altri metodi).

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `docker run --rm -v "$(pwd)/apps/backend/src:/app/apps/backend/src" -v "$(pwd)/packages/shared-types/src:/app/packages/shared-types/src" -v comunicapa_backend_node_modules:/app/node_modules -w /app/apps/backend comunicapa/backend:dev node_modules/.bin/jest campaigns.service --maxWorkers=2`
Expected: PASS su tutti i nuovi test.

- [ ] **Step 5: Aggiungi l'endpoint nel controller**

In `apps/backend/src/campaigns/campaigns.controller.ts`, vicino ad altri `@Get(':id/...)` semplici (es. dopo `getStats`):

```ts
  @Get(':id/attachments/preview-file')
  async previewAttachmentFile(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('filename') filename: string,
    @Res() res: Response,
  ): Promise<void> {
    const { path, contentType } = await this.campaignsService.resolveAttachmentPreviewFilePath(id, filename);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.sendFile(path);
  }
```

Verifica che `Response` (da `express`) e `@Res`/`@Query` siano già importati in cima al file (usati da altri endpoint tipo `getDraftCsv`/export CSV) — se `res.sendFile` non è disponibile nel tipo `Response` usato altrove nel file, usa invece lo stesso pattern stream già impiegato per altri download nel repo (`fs.createReadStream(path).pipe(res)`), verificando quale dei due pattern è già in uso in questo controller prima di introdurne uno nuovo.

- [ ] **Step 6: Esegui la suite completa e type-check**

```bash
docker run --rm -v "$(pwd)/apps/backend/src:/app/apps/backend/src" -v "$(pwd)/packages/shared-types/src:/app/packages/shared-types/src" -v comunicapa_backend_node_modules:/app/node_modules -w /app/apps/backend comunicapa/backend:dev node_modules/.bin/jest --maxWorkers=2
docker run --rm -v "$(pwd)/apps/backend/src:/app/apps/backend/src" -v comunicapa_backend_node_modules:/app/node_modules -w /app/apps/backend comunicapa/backend:dev node_modules/.bin/tsc --noEmit
```

Expected: nessuna regressione rispetto alla baseline corrente, nessun errore di tipo.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/campaigns/campaigns.service.ts apps/backend/src/campaigns/campaigns.controller.ts apps/backend/src/campaigns/campaigns.service.spec.ts
git commit -m "feat(backend): endpoint GET /admin/campaigns/:id/attachments/preview-file"
```

---

### Task 2: Frontend — estrai pannello anteprima step4 in componente condiviso

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Produces: componente `WizRecipientPreviewPanel` (funzione locale nello stesso file, non un nuovo file — coerente con lo stile del resto del wizard, tutto in `App.tsx`), props: `{ wizValidRows, wizPreviewIndex, setWizPreviewIndex, wizPreviewResult, wizPreviewLoading, wizPreviewChannelTab, setWizPreviewChannelTab, wizChannel, wizAppIoMode, wizMapping }`.
- Consumes: stati esistenti invariati (nessun nuovo stato in questo task).

- [ ] **Step 1: Individua il blocco JSX esistente da estrarre**

In `apps/frontend-admin/src/App.tsx`, cerca il commento `{/* Right Column: Live Preview with Paging */}` (dentro il blocco `wizStep === 4`) — è il pannello destro con tab canale, barra sfoglia prec/succ, box oggetto+corpo. Copia l'intero blocco (dal `<div className="col-lg-6">` di apertura alla sua chiusura, prima della chiusura del `<div className="row">` genitore).

- [ ] **Step 2: Crea il componente estraendo il blocco**

Prima della funzione principale del componente wizard (o vicino ad altri componenti locali già definiti nello stesso file, se esistono — cerca pattern tipo `function ChannelBadge` o simili per posizionarlo in modo coerente), aggiungi:

```tsx
function WizRecipientPreviewPanel({
  wizValidRows,
  wizPreviewIndex,
  setWizPreviewIndex,
  wizPreviewResult,
  wizPreviewLoading,
  wizPreviewChannelTab,
  setWizPreviewChannelTab,
  wizChannel,
  wizAppIoMode,
  wizMapping,
}: {
  wizValidRows: Record<string, string>[];
  wizPreviewIndex: number;
  setWizPreviewIndex: React.Dispatch<React.SetStateAction<number>>;
  wizPreviewResult: { subject: string; bodyHtml?: string; bodyMarkdown?: string } | null;
  wizPreviewLoading: boolean;
  wizPreviewChannelTab: 'MAIN' | 'APP_IO';
  setWizPreviewChannelTab: (tab: 'MAIN' | 'APP_IO') => void;
  wizChannel: string;
  wizAppIoMode: string;
  wizMapping: Record<string, string>;
}) {
  return (
    <div className="col-lg-6">
      <h4 className="h6 fw-bold text-dark mb-2">Anteprima Live Destinatari ({wizValidRows.length} totali)</h4>
      <p className="small text-muted mb-3">Sfoglia i record validi del CSV per vedere come verranno risolti i parametri Jolly. Anteprima renderizzata con lo stesso motore usato per l'invio reale (logo, footer e link inclusi).</p>

      {(wizChannel === 'EMAIL' || wizChannel === 'PEC') && wizAppIoMode !== 'none' && (
        <div className="btn-group btn-group-sm mb-3" role="group">
          <button
            type="button"
            className={`btn ${wizPreviewChannelTab === 'MAIN' ? 'btn-primary' : 'btn-outline-secondary'}`}
            onClick={() => setWizPreviewChannelTab('MAIN')}
          >
            <i className="fas fa-envelope me-1"></i> {wizChannel}
          </button>
          <button
            type="button"
            className={`btn ${wizPreviewChannelTab === 'APP_IO' ? 'btn-primary' : 'btn-outline-secondary'}`}
            onClick={() => setWizPreviewChannelTab('APP_IO')}
          >
            <i className="fas fa-mobile-screen me-1"></i> App IO
          </button>
        </div>
      )}

      <div className="d-flex align-items-center justify-content-between p-2 border rounded bg-light mb-3">
        <button
          className="btn btn-sm btn-outline-secondary"
          disabled={wizPreviewIndex === 0}
          onClick={() => setWizPreviewIndex(i => Math.max(0, i - 1))}
        >
          <i className="fas fa-chevron-left"></i> Prec.
        </button>
        <span className="small fw-bold">Record {wizPreviewIndex + 1} di {wizValidRows.length}</span>
        <button
          className="btn btn-sm btn-outline-secondary"
          disabled={wizPreviewIndex >= wizValidRows.length - 1}
          onClick={() => setWizPreviewIndex(i => Math.min(wizValidRows.length - 1, i + 1))}
        >
          Succ. <i className="fas fa-chevron-right"></i>
        </button>
      </div>

      {wizValidRows[wizPreviewIndex] && (
        <div className="border rounded p-3" style={{ background: '#f8fafc' }}>
          <div className="mb-2 text-muted" style={{ fontSize: '0.8rem' }}>
            <strong>A:</strong> {wizValidRows[wizPreviewIndex][wizMapping.email || ''] || wizValidRows[wizPreviewIndex][wizMapping.pec || ''] || 'N/A'}<br />
            <strong>Oggetto:</strong> {wizPreviewLoading ? '...' : (wizPreviewResult?.subject ?? '')}
          </div>
          {wizPreviewLoading && !wizPreviewResult ? (
            <div className="text-center text-muted small py-4">
              <i className="fas fa-spinner fa-spin me-1"></i> Rendering anteprima...
            </div>
          ) : wizPreviewChannelTab === 'APP_IO' ? (
            <div className="bg-white border rounded p-3" data-color-mode="light">
              <MDEditor.Markdown source={wizPreviewResult?.bodyMarkdown ?? ''} />
            </div>
          ) : wizPreviewResult?.bodyHtml ? (
            <div
              className="bg-white border rounded overflow-hidden"
              style={{ padding: '4px' }}
              dangerouslySetInnerHTML={{ __html: wizPreviewResult.bodyHtml }}
            />
          ) : wizPreviewResult?.bodyMarkdown ? (
            <div className="bg-white border rounded p-3" data-color-mode="light">
              <MDEditor.Markdown source={wizPreviewResult.bodyMarkdown} />
            </div>
          ) : (
            <div className="text-center text-muted small py-4">Nessuna anteprima disponibile per questo canale.</div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Sostituisci il blocco originale in step4 con l'uso del componente**

Dove prima c'era il blocco JSX copiato allo Step 1, sostituisci con:

```tsx
                  <WizRecipientPreviewPanel
                    wizValidRows={wizValidRows}
                    wizPreviewIndex={wizPreviewIndex}
                    setWizPreviewIndex={setWizPreviewIndex}
                    wizPreviewResult={wizPreviewResult}
                    wizPreviewLoading={wizPreviewLoading}
                    wizPreviewChannelTab={wizPreviewChannelTab}
                    setWizPreviewChannelTab={setWizPreviewChannelTab}
                    wizChannel={wizChannel}
                    wizAppIoMode={wizAppIoMode}
                    wizMapping={wizMapping}
                  />
```

- [ ] **Step 4: Type-check**

Run: `docker run --rm -v "$(pwd)/apps/frontend-admin/src:/app/apps/frontend-admin/src" -v "$(pwd)/packages/shared-types/src:/app/packages/shared-types/src" -v comunicapa_admin_node_modules:/app/node_modules -w /app/apps/frontend-admin comunicapa/frontend-admin:dev node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore. Se i tipi di `wizPreviewChannelTab`/`setWizPreviewChannelTab`/`wizMapping` reali differiscono da quelli assunti sopra (es. `wizMapping` ha un tipo più specifico con chiavi note invece di `Record<string,string>`), adatta la firma del componente al tipo reale trovato nel file.

- [ ] **Step 5: Verifica manuale in browser**

Apri il wizard, arriva allo step 4 con una campagna EMAIL con co-consegna App IO, conferma che l'anteprima si comporta esattamente come prima (nessuna regressione visibile — questo task è puramente un'estrazione, zero cambi di comportamento).

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "refactor(frontend-admin): estrae pannello anteprima step4 in WizRecipientPreviewPanel"
```

---

### Task 3: Frontend — estendi l'effect di anteprima allo step 6

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: l'effect esistente che popola `wizPreviewResult` (righe ~869-914 prima di questo piano, verifica il numero reale dopo Task 2).

- [ ] **Step 1: Estendi la guardia dell'effect**

Trova l'effect che inizia con `// Anteprima Step 4: chiama l'endpoint reale di rendering...` e la sua guardia:

```tsx
    if (wizStep !== 4 || !wizValidRows[wizPreviewIndex]) {
      return;
    }
```

Cambiala in:

```tsx
    if ((wizStep !== 4 && wizStep !== 6) || !wizValidRows[wizPreviewIndex]) {
      return;
    }
```

Aggiungi `wizStep` è già nelle dependency dell'effect (verifica sia presente nell'array delle dipendenze — se manca aggiungilo, ma dovrebbe già esserci dato che la guardia lo usa).

- [ ] **Step 2: Type-check**

Run: `docker run --rm -v "$(pwd)/apps/frontend-admin/src:/app/apps/frontend-admin/src" -v "$(pwd)/packages/shared-types/src:/app/packages/shared-types/src" -v comunicapa_admin_node_modules:/app/node_modules -w /app/apps/frontend-admin comunicapa/frontend-admin:dev node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): effect anteprima attivo anche allo step 6"
```

---

### Task 4: Frontend — componente `WizAttachmentInlinePreview`

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Produces: componente `WizAttachmentInlinePreview`, props `{ campaignId: string | null; row: Record<string,string>; attachmentEntry: { key: string; label: string; labelColumn?: string }; token: string | null }`. Nessun export — locale al file, come `WizRecipientPreviewPanel`.
- Consumes: `ADMIN_API_BASE` (esistente), pattern fetch con header `Authorization` (esistente, stesso stile dell'effect di anteprima — fetch diretto, non `apiFetch`, per coerenza con codice adiacente e per poter gestire liberamente errori/loading locali al componente).

- [ ] **Step 1: Scrivi il componente**

Vicino a `WizRecipientPreviewPanel` (subito dopo la sua definizione):

```tsx
function WizAttachmentInlinePreview({
  campaignId,
  row,
  attachmentEntry,
  token,
}: {
  campaignId: string | null;
  row: Record<string, string>;
  attachmentEntry: { key: string; label: string; labelColumn?: string };
  token: string | null;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filename = row[attachmentEntry.key] || '';
  const isPdf = filename.toLowerCase().endsWith('.pdf');

  useEffect(() => {
    setObjectUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setError(null);

    if (!campaignId || !filename) return;

    let cancelled = false;
    setLoading(true);
    fetch(`${ADMIN_API_BASE}/campaigns/${campaignId}/attachments/preview-file?filename=${encodeURIComponent(filename)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(res.status === 404 ? 'Allegato non trovato — verifica il Passo 5' : 'Errore caricamento allegato'))))
      .then((blob) => {
        if (cancelled) return;
        setObjectUrl(URL.createObjectURL(blob));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Errore caricamento allegato');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, filename]);

  useEffect(() => {
    return () => {
      setObjectUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, []);

  if (!filename) return null;

  return (
    <div className="mt-3 pt-3 border-top">
      <strong className="d-block mb-2">{attachmentEntry.label || 'Allegato'}: {filename}</strong>
      {loading && <div className="text-center text-muted small py-3"><i className="fas fa-spinner fa-spin me-1"></i> Caricamento allegato...</div>}
      {error && <div className="text-danger small">{error}</div>}
      {!loading && !error && objectUrl && isPdf && (
        <embed type="application/pdf" src={objectUrl} style={{ width: '100%', height: '400px', border: '1px solid #dee2e6', borderRadius: '4px' }} />
      )}
      {!loading && !error && objectUrl && (
        <a href={objectUrl} download={filename} className="btn btn-sm btn-outline-secondary mt-2">
          <i className="fas fa-download me-1"></i> Scarica
        </a>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `docker run --rm -v "$(pwd)/apps/frontend-admin/src:/app/apps/frontend-admin/src" -v "$(pwd)/packages/shared-types/src:/app/packages/shared-types/src" -v comunicapa_admin_node_modules:/app/node_modules -w /app/apps/frontend-admin comunicapa/frontend-admin:dev node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore (componente non ancora montato da nessuna parte in questo task — solo dichiarato, `tsc` non segnala componenti inutilizzati come errore).

- [ ] **Step 3: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): componente WizAttachmentInlinePreview (fetch+blob+embed)"
```

---

### Task 5: Frontend — pannello SEND/POSTAL (indirizzo + allegato)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Produces: componente `WizAddressAttachmentPreviewPanel`, props `{ wizValidRows, wizPreviewIndex, setWizPreviewIndex, wizPostalAddressColumn, wizPostalMunicipalityColumn, wizPostalZipColumn, wizPostalProvinceColumn, wizAttachments, campaignId, token }`.
- Consumes: `WizAttachmentInlinePreview` (Task 4), stessa barra sfoglia già vista in `WizRecipientPreviewPanel` (duplicata qui con lo stesso `wizPreviewIndex`/`setWizPreviewIndex` — un solo stato condiviso, due render diversi a seconda del canale).

- [ ] **Step 1: Scrivi il componente**

Subito dopo `WizAttachmentInlinePreview`:

```tsx
function WizAddressAttachmentPreviewPanel({
  wizValidRows,
  wizPreviewIndex,
  setWizPreviewIndex,
  wizPostalAddressColumn,
  wizPostalMunicipalityColumn,
  wizPostalZipColumn,
  wizPostalProvinceColumn,
  wizAttachments,
  campaignId,
  token,
}: {
  wizValidRows: Record<string, string>[];
  wizPreviewIndex: number;
  setWizPreviewIndex: React.Dispatch<React.SetStateAction<number>>;
  wizPostalAddressColumn: string;
  wizPostalMunicipalityColumn: string;
  wizPostalZipColumn: string;
  wizPostalProvinceColumn: string;
  wizAttachments: Array<{ key: string; label: string; labelColumn?: string }>;
  campaignId: string | null;
  token: string | null;
}) {
  const row = wizValidRows[wizPreviewIndex];

  return (
    <div>
      <h4 className="h6 fw-bold text-dark mb-2">Anteprima Destinatari ({wizValidRows.length} totali)</h4>
      <p className="small text-muted mb-3">Sfoglia i record validi del CSV per verificare indirizzo e allegato reale prima dell'invio.</p>

      <div className="d-flex align-items-center justify-content-between p-2 border rounded bg-light mb-3">
        <button
          className="btn btn-sm btn-outline-secondary"
          disabled={wizPreviewIndex === 0}
          onClick={() => setWizPreviewIndex(i => Math.max(0, i - 1))}
        >
          <i className="fas fa-chevron-left"></i> Prec.
        </button>
        <span className="small fw-bold">Record {wizPreviewIndex + 1} di {wizValidRows.length}</span>
        <button
          className="btn btn-sm btn-outline-secondary"
          disabled={wizPreviewIndex >= wizValidRows.length - 1}
          onClick={() => setWizPreviewIndex(i => Math.min(wizValidRows.length - 1, i + 1))}
        >
          Succ. <i className="fas fa-chevron-right"></i>
        </button>
      </div>

      {row && (
        <div className="border rounded p-3" style={{ background: '#f8fafc' }}>
          <div className="mb-2 text-muted" style={{ fontSize: '0.85rem' }}>
            <strong>Indirizzo:</strong> {row[wizPostalAddressColumn] || 'N/A'}<br />
            <strong>Comune:</strong> {row[wizPostalMunicipalityColumn] || 'N/A'} &nbsp;
            <strong>CAP:</strong> {row[wizPostalZipColumn] || 'N/A'} &nbsp;
            <strong>Provincia:</strong> {row[wizPostalProvinceColumn] || 'N/A'}
          </div>
          {wizAttachments.map((entry, idx) => (
            <WizAttachmentInlinePreview
              key={entry.key || idx}
              campaignId={campaignId}
              row={row}
              attachmentEntry={entry}
              token={token}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `docker run --rm -v "$(pwd)/apps/frontend-admin/src:/app/apps/frontend-admin/src" -v "$(pwd)/packages/shared-types/src:/app/packages/shared-types/src" -v comunicapa_admin_node_modules:/app/node_modules -w /app/apps/frontend-admin comunicapa/frontend-admin:dev node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 3: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): componente WizAddressAttachmentPreviewPanel per SEND/POSTAL"
```

---

### Task 6: Frontend — monta i pannelli nello step 6

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `WizRecipientPreviewPanel` (Task 2), `WizAttachmentInlinePreview` (Task 4), `WizAddressAttachmentPreviewPanel` (Task 5).

- [ ] **Step 1: Individua il blocco "Anteprima Oggetto (Record 1)" in step6**

Nel blocco `wizStep === 6`, trova la sezione:

```tsx
                    <div className="mt-3 pt-3 border-top">
                      <strong>Anteprima Oggetto (Record 1):</strong>
                      <div className="p-2 border bg-white rounded mt-1 small text-muted">
                        {wizSubject.replace(/%([^%()]+)%/gi, (match, key) => {
                          const k = key.toLowerCase().trim();
                          if (k === 'nominativo' || k === 'full_name') return getWizRowFullName(wizValidRows[0]);
                          if (k === 'codice_fiscale' || k === 'cf') return wizValidRows[0]?.[wizMapping.codice_fiscale] || '';
                          return wizValidRows[0]?.[key] || match;
                        })}
                      </div>
                    </div>
```

Sostituiscila con un rendering condizionale sul canale:

```tsx
                    <div className="mt-3 pt-3 border-top">
                      {(wizChannel === 'EMAIL' || wizChannel === 'PEC' || wizChannel === 'APP_IO') ? (
                        <WizRecipientPreviewPanel
                          wizValidRows={wizValidRows}
                          wizPreviewIndex={wizPreviewIndex}
                          setWizPreviewIndex={setWizPreviewIndex}
                          wizPreviewResult={wizPreviewResult}
                          wizPreviewLoading={wizPreviewLoading}
                          wizPreviewChannelTab={wizPreviewChannelTab}
                          setWizPreviewChannelTab={setWizPreviewChannelTab}
                          wizChannel={wizChannel}
                          wizAppIoMode={wizAppIoMode}
                          wizMapping={wizMapping}
                        />
                      ) : (
                        <WizAddressAttachmentPreviewPanel
                          wizValidRows={wizValidRows}
                          wizPreviewIndex={wizPreviewIndex}
                          setWizPreviewIndex={setWizPreviewIndex}
                          wizPostalAddressColumn={wizPostalAddressColumn}
                          wizPostalMunicipalityColumn={wizPostalMunicipalityColumn}
                          wizPostalZipColumn={wizPostalZipColumn}
                          wizPostalProvinceColumn={wizPostalProvinceColumn}
                          wizAttachments={wizAttachments}
                          campaignId={wizCampaignId}
                          token={token}
                        />
                      )}
                      {(wizChannel === 'EMAIL' || wizChannel === 'PEC' || wizChannel === 'APP_IO') && wizAttachments.length > 0 && wizValidRows[wizPreviewIndex] && (
                        <>
                          {wizAttachments.map((entry, idx) => (
                            <WizAttachmentInlinePreview
                              key={entry.key || idx}
                              campaignId={wizCampaignId}
                              row={wizValidRows[wizPreviewIndex]}
                              attachmentEntry={entry}
                              token={token}
                            />
                          ))}
                        </>
                      )}
                    </div>
```

Nota: `WizRecipientPreviewPanel` è già dentro una `<div className="col-lg-6">` (definita al suo interno, vedi Task 2) — dentro il layout a singola colonna di step6 (`maxWidth: 600px`) questo produrrà una colonna Bootstrap senza una `row` genitore a 12 colonne. Verifica visivamente allo Step 3 sotto se serve avvolgere con `<div className="row">...</div>` o se il componente si adatta comunque bene (Bootstrap gestisce `col-lg-6` anche fuori da un `.row` esplicito con solo effetti minori di padding) — se il risultato visivo è chiaramente rotto, avvolgi la chiamata al componente in un `<div className="row"><div className="col-12">...contenuto...</div></div>` invece di modificare il componente condiviso (che deve restare identico a come lo usa step4).

- [ ] **Step 2: Type-check**

Run: `docker run --rm -v "$(pwd)/apps/frontend-admin/src:/app/apps/frontend-admin/src" -v "$(pwd)/packages/shared-types/src:/app/packages/shared-types/src" -v comunicapa_admin_node_modules:/app/node_modules -w /app/apps/frontend-admin comunicapa/frontend-admin:dev node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 3: Verifica manuale in browser**

Testa tutti e 5 i canali:
- EMAIL/PEC con e senza co-consegna App IO, con e senza allegato configurato: verifica anteprima corpo/oggetto identica a step4, più blocco allegato inline (embed se PDF) quando configurato.
- APP_IO diretto: verifica anteprima markdown.
- POSTAL: verifica indirizzo pieno sui 4 campi, allegato PDF sempre presente e visibile inline, sfoglia funzionante.
- SEND: stesso di POSTAL.
- Allegato non-PDF (es. da uno ZIP con file non-PDF, se il flusso di test lo permette): verifica che compaia solo il link "Scarica", nessun embed.
- Naviga prec/succ e conferma che l'anteprima (corpo o indirizzo+allegato) si aggiorna per ogni record.

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): monta pannelli anteprima ricca nello step 6"
```

---

### Task 7: Frontend — gate "Avvia Test" su allegato mancante (SEND/POSTAL)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: bottone "Avvia Test" esistente (`onClick={() => setWizStep(7)}`, due occorrenze in step6 — header e footer).

- [ ] **Step 1: Aggiungi stato per l'elenco file effettivamente presenti**

Vicino alle altre dichiarazioni `wiz*` di stato, aggiungi:

```tsx
  const [wizUploadedAttachmentFiles, setWizUploadedAttachmentFiles] = useState<string[] | null>(null);
```

- [ ] **Step 2: Popola l'elenco dopo l'upload allegati (step 5) o all'ingresso in step 6**

Trova `handleWizUploadAttachments` (Task 8 del piano precedente — già esistente): dopo l'upload riuscito e prima di `setWizStep(6)`, aggiungi una chiamata che elenca i file effettivamente presenti sul server per popolare `wizUploadedAttachmentFiles`. Se non esiste già un endpoint che elenca i file (verifica: cerca un `@Get` su `attachments` che ritorni un array di nomi file in `campaigns.controller.ts` — se non c'è, riusa l'informazione già disponibile lato client: `wizPdfFiles.map(f => f.name)`, che è l'elenco dei file selezionati nel browser al passo 5, sufficiente come proxy dato che l'upload appena completato con successo garantisce che siano tutti sul server):

```tsx
      setWizUploadedAttachmentFiles(wizPdfFiles.map((f) => f.name));
```

Aggiungi questa riga subito prima di `setWizStep(6)` dentro `handleWizUploadAttachments`.

- [ ] **Step 3: Calcola se il record di test ha l'allegato pronto**

Vicino alla dichiarazione dei bottoni "Avvia Test" in step6, aggiungi (o inline nella condizione `disabled`) un calcolo:

```tsx
  const wizTestAttachmentReady = wizChannel !== 'SEND' && wizChannel !== 'POSTAL'
    ? true
    : wizAttachments.every((entry) => {
        const expectedFilename = wizValidRows[0]?.[entry.key];
        return expectedFilename && (wizUploadedAttachmentFiles?.includes(expectedFilename) ?? false);
      });
```

Posiziona questo calcolo (una `const` semplice, non uno stato) nel corpo del componente principale del wizard, prima del JSX di ritorno, così è disponibile per entrambe le occorrenze del bottone "Avvia Test".

- [ ] **Step 4: Aggiorna la condizione `disabled` di ENTRAMBE le occorrenze del bottone "Avvia Test"**

Le due occorrenze (header e footer di step6) hanno oggi:

```tsx
                        disabled={wizSending || !wizCampaignId}
                        title={!wizCampaignId ? 'Completa prima il passo Upload Allegati' : undefined}
```

Cambia entrambe in:

```tsx
                        disabled={wizSending || !wizCampaignId || !wizTestAttachmentReady}
                        title={!wizCampaignId ? 'Completa prima il passo Upload Allegati' : (!wizTestAttachmentReady ? 'Allegato mancante per il primo destinatario — verifica il Passo 5' : undefined)}
```

- [ ] **Step 5: Type-check**

Run: `docker run --rm -v "$(pwd)/apps/frontend-admin/src:/app/apps/frontend-admin/src" -v "$(pwd)/packages/shared-types/src:/app/packages/shared-types/src" -v comunicapa_admin_node_modules:/app/node_modules -w /app/apps/frontend-admin comunicapa/frontend-admin:dev node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 6: Verifica manuale in browser**

Crea una campagna POSTAL, arriva allo step 5, carica SOLO alcuni degli allegati richiesti (non quello del primo record), procedi a step 6, conferma che "Avvia Test" sia disabilitato col tooltip corretto. Carica anche l'allegato mancante, torna a step 6, conferma che si riabiliti.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): gate Avvia Test su allegato mancante per SEND/POSTAL"
```

---

## Self-Review

**Copertura spec:** pannello EMAIL/PEC/APP_IO riusato da step4 (Task 2-3, 6) ✓, pannello SEND/POSTAL indirizzo+allegato (Task 5-6) ✓, anteprima allegato inline su tutti i canali se configurato (Task 4, 6) ✓, embed solo se PDF altrimenti solo download (Task 4) ✓, niente token in query — blob URL da fetch autenticato (Task 4) ✓, nuovo endpoint backend con whitelist anti-traversal (Task 1) ✓, gate step7 su allegato mancante (Task 7) ✓, sfoglia condivisa un solo stato (`wizPreviewIndex`) tra tutti i pannelli (Task 2, 5) ✓.

**Rischio noto:** Task 7 usa `wizPdfFiles.map(f => f.name)` come proxy per "file presenti sul server" invece di interrogare il server stesso — accettabile perché l'upload a step5 è sincrono/atomico rispetto alla UI (se `handleWizUploadAttachments` ha già avuto successo, i file sono garantiti presenti), ma se in futuro l'upload diventa asincrono/best-effort questo proxy andrebbe sostituito con una vera chiamata server. Documentato inline nel task.
