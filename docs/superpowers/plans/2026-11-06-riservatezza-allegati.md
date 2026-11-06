# Riservatezza allegati e bozze — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contenuto allegati e bozze di campagna visibili solo a creatore, admin e firmatario indicato.

**Architecture:** Una regola pura (`campaign-access.util.ts`) usata ovunque. Bozze: un interceptor globale (`APP_INTERCEPTOR`, gira dopo `JwtAuthGuard`/`RolesGuard`) risponde 404 su ogni route `/admin/campaigns/:id…` per bozze non visibili, più filtri su elenco/ricerca. Allegati: controllo nei service dei singoli endpoint (403 + audit) e link di download neutralizzati nelle anteprime backoffice.

**Tech Stack:** NestJS 12 ESM, TypeORM/Postgres, Vitest, React 19.

**Spec:** `docs/superpowers/specs/2026-11-06-riservatezza-allegati-design.md` (leggerla prima di ogni task).

## Global Constraints

- Regola: `admin` → sì; `username === campaign.createdBy` → sì; `campaign.signerUsername` non null e `=== username` → sì; altrimenti no.
- Bozza = `campaign.status === CampaignStatus.DRAFT`. Non bozza → campagna visibile a tutti (solo allegati protetti).
- Bozza non visibile → **404** (`NotFoundException`, stesso messaggio di "non trovata"). Allegato negato su campagna visibile → **403** `ForbiddenException('Allegato visibile solo a chi ha creato la campagna, agli amministratori e al firmatario indicato')`.
- Ogni 403 su allegato → `AuditLogsService.log({ action: 'ATTACHMENT_ACCESS_DENIED', operator, campaignId, campaignName, details: { endpoint } })`. Mai CF/nome destinatario nei details (solo id).
- Invariati: `citizen/*`, `public/download/*`, `external/v2/*`, `send-legal-facts*`, nomi file, `previewMessage` senza `campaignId`.
- Test: `docker compose exec backend node_modules/.bin/vitest run <pattern>`; type-check `tsc --noEmit` e `tsc -p tsconfig.spec.json --noEmit`. Baseline: 1 fallimento noto in `app.controller.spec.ts`.
- Dopo modifiche a `apps/backend/src/` → `docker compose restart backend` (watch Windows inaffidabile).
- Commit sul branch `docs/riservatezza-allegati-design` (già creato da `main`, contiene spec e piano), mai direttamente su main.

## Review Focus

1. Route `:id` campagna fuori da `campaigns.controller.ts` (`signed-attachments`, `signature-verification`, `remote-sign`, `poste-tracking`) → anche loro 404 per bozza altrui. Test nel Task 2 sui path.
2. Gruppo multicanale con membri di proprietari diversi → elenco mostra solo membri visibili, nessun crash di `aggregateCampaignGroups` lato frontend con gruppo parziale. Test Task 2 (backend filtra per membro).
3. Firmatario cambiato a firma remota in corso → 400, accesso non revocato a metà. Test Task 5.
4. Campagna lanciata e poi riportata a DRAFT (lancio fallito) → torna invisibile. Coperto dalla regola pura (Task 1) che legge lo stato corrente, test dedicato.
5. Link `preview=1` già generati prima del deploy restano validi fino a scadenza: accettato, non si invalida (nota in guida non necessaria). Nessun test.

---

### Task 1: Regola di accesso + colonna `signer_username`

**Files:**
- Create: `apps/backend/src/campaigns/campaign-access.util.ts`
- Create: `apps/backend/src/campaigns/campaign-access.util.spec.ts`
- Modify: `apps/backend/src/entities/campaign.entity.ts` (nuova colonna)
- Create: `apps/backend/src/database/migrations/1791000000000-AddCampaignSigner.ts`

**Interfaces:**
- Produces:
  - `type CampaignAccessSubject = Pick<Campaign, 'createdBy' | 'signerUsername' | 'status'>`
  - `canReadCampaignAttachments(campaign: CampaignAccessSubject, requester: CampaignRequester): boolean`
  - `canViewCampaign(campaign: CampaignAccessSubject, requester: CampaignRequester): boolean` — `status !== DRAFT || canReadCampaignAttachments(...)`
  - `ATTACHMENT_DENIED_MESSAGE` (stringa dei Global Constraints)
  - `Campaign.signerUsername: string | null` (`@Column({ name: 'signer_username', type: 'varchar', length: 255, nullable: true })`)

- [ ] **Step 1: Test** `campaign-access.util.spec.ts`: tabella `it.each` con `{ role, username, createdBy, signerUsername, status, read, view }`:
  - admin/qualunque → read true, view true
  - user = creatore → true/true
  - user = firmatario → true/true
  - altro user, DRAFT → false/false
  - altro user, signerUsername null, DRAFT → false/false
  - altro user, `CampaignStatus.RUNNING` → read false, view true
  - altro user, campagna tornata `DRAFT` → view false
- [ ] **Step 2:** `vitest run campaign-access` → FAIL (modulo mancante).
- [ ] **Step 3:** Implementare util + colonna entity + migration (`ALTER TABLE "campaigns" ADD "signer_username" character varying(255)`, down = DROP COLUMN; stile `1790700000000-AddDomicileVerificationJobOwner.ts`).
- [ ] **Step 4:** `vitest run campaign-access` → PASS; `tsc --noEmit` pulito.
- [ ] **Step 5:** Commit `feat(campaigns): regola accesso allegati/bozze e colonna firmatario`.

### Task 2: Bozze invisibili — interceptor 404 + filtri elenco

**Files:**
- Create: `apps/backend/src/campaigns/campaign-access.interceptor.ts` (+ `.spec.ts`)
- Modify: `apps/backend/src/campaigns/campaigns.module.ts` (provider `{ provide: APP_INTERCEPTOR, useClass: CampaignAccessInterceptor }`)
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` — `findAll(requester)`, `getRecentActivity(requester)`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts:67-77` (passa `req.user`)

**Interfaces:**
- Consumes: `canViewCampaign` (Task 1).
- Produces: `CampaignsService.findAll(requester: CampaignRequester): Promise<Campaign[]>`, `getRecentActivity(requester: CampaignRequester)`.

- [ ] **Step 1: Test interceptor** (`ExecutionContext` finto con `req.route.path`, `req.params.id`, `req.user`, repo mock `findOne({ where:{id}, select:['id','createdBy','signerUsername','status'] })`):
  - path `/admin/campaigns/:id/stats`, bozza altrui → `NotFoundException`, handler non chiamato
  - stessi path per `/admin/campaigns/:id/signature/unsigned.zip`, `/admin/campaigns/:id/remote-sign`, `/admin/campaigns/:id/signature-verification`, `/admin/campaigns/:id/postal/poste-check` → 404
  - bozza del creatore / firmatario / admin → `next.handle()` chiamato
  - campagna non bozza, altro user → passa
  - path `/admin/campaigns/stats/global`, `/admin/campaigns/preview`, `/admin/enrichment/jobs/:id` → passa senza query DB
  - campagna inesistente → passa (l'handler darà il suo 404)
  - nessun `req.user` (route pubblica) → passa
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implementare `CampaignAccessInterceptor`: match `req.route?.path` con `/^\/admin\/campaigns\/:id(\/|$)/`; se `req.user?.type !== 'operator'` o nessun match → `next.handle()`; altrimenti carica i 4 campi e lancia `NotFoundException(\`Campaign ${id} not found\`)` se `!canViewCampaign`. Verificare a runtime (log temporaneo o test e2e veloce) che `req.route.path` contenga il prefisso completo del controller; se Nest lo espone diverso, adattare il match ma tenere la stessa copertura.
- [ ] **Step 4: Test service** `findAll`: bozza altrui esclusa, bozza propria/firmata/non-bozza inclusa, admin vede tutto (filtro in SQL: `status <> 'draft' OR created_by = :u OR signer_username = :u`, nessun filtro per admin). Stesso test su `getRecentActivity`.
- [ ] **Step 5:** Implementare, aggiornare controller, run test interceptor+service → PASS; suite campaigns verde rispetto al baseline.
- [ ] **Step 6:** Verifica manuale: `docker compose restart backend`, con token `role:'user', username:'altro'` (snippet CLAUDE.md) `fetch` su `/admin/campaigns/<bozza admin>/stats` → 404, su una campagna lanciata → 200.
- [ ] **Step 7:** Commit `feat(campaigns): bozze visibili solo a creatore, admin, firmatario`.

### Task 3: Ricerca notifiche e anteprime — bozze e link

**Files:**
- Modify: `apps/backend/src/channels/template.helper.ts` (`processTemplate`, nuovo ultimo parametro)
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` — `renderMessage` (nuovo ultimo parametro), `renderMessageForRecipient`, `renderAppIoCoDeliveryPreview`, `previewMessage`
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts:159` (`preview` passa `req.user`)
- Modify: `apps/backend/src/notifications-search/notifications-search.controller.ts`, `.service.ts` (`search`, `getDetail`, `downloadAttachment`)
- Test: `template.helper.spec.ts` (esistente o nuovo), `notifications-search.service.spec.ts`, `campaigns.service.spec.ts`

**Interfaces:**
- Consumes: `canViewCampaign`, `canReadCampaignAttachments`, `ATTACHMENT_DENIED_MESSAGE` (Task 1).
- Produces:
  - `processTemplate(..., preview = false, redactDownloadLinks = false)`; con `true` ogni URL di download = `'#allegato-riservato'`, nessuna chiamata a `signDownloadLink`.
  - `renderMessageForRecipient(recipientId, linkChannelTag?, preview = true, redactDownloadLinks = false)`; stesso parametro su `renderAppIoCoDeliveryPreview`.
  - `previewMessage(dto, requester: CampaignRequester)`.
  - `NotificationsSearchService.search(filters, requester)`, `getDetail(recipientId, requester)` → DTO con `canReadAttachments: boolean`, `downloadAttachment(recipientId, index, requester)`.

- [ ] **Step 1: Test** `processTemplate` con `redactDownloadLinks=true`: output contiene `#allegato-riservato`, non contiene `public/download` né `sig=`; con `false` output identico a oggi (test esistenti invariati).
- [ ] **Step 2: Test** notifications-search:
  - `search` con altro user esclude destinatari di bozze altrui (condizione SQL come Task 2 su `campaign.*`), admin li vede.
  - `getDetail` destinatario di bozza altrui → `NotFoundException`.
  - `getDetail` campagna lanciata, altro user → `canReadAttachments:false` e `renderMessageForRecipient` chiamato con `redactDownloadLinks=true`; creatore → `true`/`false`.
  - `downloadAttachment` altro user → `ForbiddenException` + `auditLogs.log` con `action:'ATTACHMENT_ACCESS_DENIED'`, `details.endpoint:'notifications-search/attachment'`.
- [ ] **Step 3: Test** `previewMessage` con `campaignId` + CF reale e requester non ammesso → `renderMessage` riceve `redactDownloadLinks=true`; ammesso → link reale come oggi; senza `campaignId` invariato.
- [ ] **Step 4:** run → FAIL.
- [ ] **Step 5:** Implementare. `NotificationsSearchService` riceve `AuditLogsService` (verificare import del modulo). Il portale cittadino (`citizen.service.ts:69`) non cambia chiamata.
- [ ] **Step 6:** run test mirati + `citizen` spec → PASS; `tsc -p tsconfig.spec.json --noEmit` pulito.
- [ ] **Step 7:** Commit `feat(notifiche): allegati e bozze riservati in ricerca e anteprime`.

### Task 4: Endpoint allegati campagna e firma — 403 + flag

**Files:**
- Modify: `apps/backend/src/campaigns/campaigns.service.ts:3785` (`resolveAttachmentPreviewFilePath(id, filename, requester)`)
- Modify: `apps/backend/src/campaigns/campaigns.controller.ts:79-85` (`findOne` aggiunge `canReadAttachments`, `signerDisplayName`), `:622` (preview-file passa `req.user`)
- Modify: `apps/backend/src/remote-sign/remote-sign.service.ts:78-92` (`assertCanRead`/`assertCanModify` applicano la regola)
- Test: `campaigns.service.spec.ts`, `remote-sign.service.spec.ts`, `signed-attachments.service.spec.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: risposta `GET admin/campaigns/:id` con `canReadAttachments: boolean`, `signerUsername: string | null`, `signerDisplayName: string | null`.

- [ ] **Step 1: Test:**
  - preview-file altro user su campagna lanciata → 403 + audit `details.endpoint:'attachments/preview-file'`; creatore/admin/firmatario → path risolto.
  - `assertCanRead`/`assertCanModify` altro user → 403 + audit (`'remote-sign'`); firmatario indicato → ok; `assertCanModify` mantiene i check SEND/DRAFT esistenti.
  - `buildUnsignedZip` altro user → 403 (passa da `assertCanRead`); firmatario → buffer.
  - regressione flusso firma: firmatario (`role:'user'`, non creatore) avvia firma remota e completa ricarico firmati.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implementare; aggiornare il commento "qualunque operatore può firmare" in `remote-sign.service.ts` e la sezione "Eccezione voluta: firma allegati SEND" in `docs/claude/campaigns-wizard.md` (ora: creatore, admin, firmatario indicato).
- [ ] **Step 4:** run → PASS.
- [ ] **Step 5:** Commit `feat(allegati): anteprima, ZIP e firma solo a creatore, admin, firmatario`.

### Task 5: Indicare il firmatario

**Files:**
- Modify: `apps/backend/src/operator-directory/operator-directory.service.ts` (`listAll`, `exists`)
- Create: `apps/backend/src/operator-directory/operator-directory.controller.ts` (`GET admin/operators`, `@Roles('user','admin')`) + registrazione nel modulo
- Modify: `apps/backend/src/campaigns/campaigns.service.ts` (`setSigner`), `campaigns.controller.ts` (`PATCH :id/signer`)
- Test: `campaigns.service.spec.ts`, `operator-directory.service.spec.ts`

**Interfaces:**
- Produces:
  - `OperatorDirectoryService.listAll(): Promise<Array<{ username: string; displayName: string }>>` ordinato per `displayName`
  - `OperatorDirectoryService.exists(username: string): Promise<boolean>`
  - `CampaignsService.setSigner(id: string, signerUsername: string | null, requester: CampaignRequester): Promise<{ previous: string | null; signerUsername: string | null }>`
  - `PATCH admin/campaigns/:id/signer` body `{ signerUsername: string | null }` → audit `action:'CAMPAIGN_SIGNER_SET'`, `details:{ previous, signerUsername }`

- [ ] **Step 1: Test** `setSigner`: altro user → `ForbiddenException` (via `assertOwnership`); non SEND o non DRAFT → `BadRequestException`; `RemoteSignJob` attivo → `BadRequestException('Firma remota in corso: attendi la fine prima di cambiare firmatario')`; username non in directory → `BadRequestException`; `null` azzera; ok → valore salvato e precedente restituito.
- [ ] **Step 2: Test** `listAll` ordinamento, `exists` true/false.
- [ ] **Step 3:** run → FAIL; implementare (DTO con `class-validator`: `@IsOptional() @IsString() @MaxLength(255)`, `null` ammesso); run → PASS.
- [ ] **Step 4:** Commit `feat(campaigns): firmatario indicato per campagne SEND in bozza`.

### Task 6: Arricchimento — ZIP e conversione

**Files:**
- Modify: `apps/backend/src/enrichment/enrichment.service.ts` (`buildResultZip(id, requester)`, `requestCampaignConversion(id, params, requester)`)
- Modify: `apps/backend/src/enrichment/enrichment.controller.ts:250-289`
- Test: `enrichment.service.spec.ts`

**Interfaces:**
- Produces: `requestCampaignConversion(id, params, requester: CampaignRequester)` — la campagna creata ha `createdBy = job.createdBy` (non il chiamante).

- [ ] **Step 1: Test:** `buildResultZip` altro user → `ForbiddenException` + audit `details.endpoint:'enrichment/result.zip'`, `campaignId` null, id job in `details.jobId`; creatore job/admin → buffer. `requestCampaignConversion` altro user → 403 + audit; admin → job BullMQ con `createdBy` = `job.createdBy`; creatore → come oggi. Job con `createdBy` vuoto/null (storici) → solo admin.
- [ ] **Step 2:** run → FAIL; implementare (controller passa `req.user`; 403 vero, non `{blocked}`: il frontend lo gestisce nel Task 7); run → PASS.
- [ ] **Step 3:** Commit `feat(arricchimento): ZIP e conversione solo a chi ha caricato e admin`.

### Task 7: Frontend admin

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx` — `interface Campaign` (:1251) aggiunge `canReadAttachments?: boolean; signerUsername?: string | null; signerDisplayName?: string | null`; anteprima allegato (~:644); download allegato notifica (~:1947); passaggio props a `SignaturePanel` (~:12675, ~:12836); bottone ZIP Arricchimento (cercare `result.zip`)
- Modify: `apps/frontend-admin/src/components/signature/SignaturePanel.tsx`
- Modify: `apps/frontend-admin/public/guida/guida.md`

**Interfaces:**
- Consumes: `GET admin/campaigns/:id` (Task 4), `GET admin/operators`, `PATCH admin/campaigns/:id/signer` (Task 5), `canReadAttachments` nel dettaglio notifica (Task 3).
- Produces: `SignaturePanel` nuove props `canReadAttachments: boolean`, `canEditSigner: boolean`, `signerUsername: string | null`, `onSignerChanged(): void`.

- [ ] **Step 1:** `SignaturePanel`: select firmatario (opzioni da `/operators`, voce "Nessun firmatario"), salva con PATCH, testo d'aiuto "Chi non compare nell'elenco deve accedere una volta a ComunicaPA"; se `!canEditSigner` mostra solo "Firmatario: <nome>". Se `!canReadAttachments` bottoni ZIP/firma remota/ricarico disabilitati con `title` = messaggio dei Global Constraints. `canEditSigner` = admin o creatore (dato da `currentUser` + `campaign.createdBy` in App).
- [ ] **Step 2:** Anteprima allegato e download allegato notifica: nascosti/disabilitati con lo stesso tooltip quando `canReadAttachments === false`; su risposta 403 mostrare il messaggio del backend invece di "Errore durante il download". Bottone ZIP Arricchimento: idem su 403.
- [ ] **Step 3:** Apertura bozza non più visibile (404 da dettaglio): messaggio "Campagna non trovata o non accessibile", ritorno all'elenco.
- [ ] **Step 4:** Guida (`guida.md`, data in testa 2026-11-06): sezione su chi vede allegati e bozze, come indicare il firmatario, "Problemi frequenti" (allegato non visibile; firmatario non in elenco → login una volta; bozza SEND esistente in attesa di firma → il creatore indica il firmatario). Titoli nuovi senza rompere ancore esistenti.
- [ ] **Step 5:** `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` pulito; `pnpm test` / `scripts/check-guida.mjs` verde (`docker compose exec frontend-admin node scripts/check-guida.mjs` o comando equivalente in `package.json`).
- [ ] **Step 6:** Verifica browser (Playwright, dev `LDAP_HOST=mock`): `admin` crea bozza SEND e indica `operator` come firmatario; `operator` vede la bozza e lo ZIP; con un terzo utente mock (se non disponibile, token `user` via fetch) la bozza non compare e su campagna lanciata il bottone allegato è disabilitato.
- [ ] **Step 7:** Commit `feat(admin): firmatario, allegati riservati e guida`.

### Task 8: Verifica finale

- [ ] **Step 1:** `docker compose exec backend node_modules/.bin/vitest run` → solo il fallimento baseline noto.
- [ ] **Step 2:** `tsc --noEmit` e `tsc -p tsconfig.spec.json --noEmit` backend puliti; type-check frontend admin pulito.
- [ ] **Step 3:** Migration su DB temporaneo (ricetta CLAUDE.md "Migration contro un DB temporaneo") → applicata senza errori.
- [ ] **Step 4:** `grep -rn "admin/campaigns/:id\|campaigns/:id" apps/backend/src --include=*.controller.ts` → ogni controller elencato è coperto dal path regex dell'interceptor.
