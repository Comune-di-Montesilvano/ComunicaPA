# Fix gestione 401/errori silenziosi nel backoffice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminare gli errori silenziosi/fuorvianti in `apps/frontend-admin` quando il JWT operatore è scaduto o una chiamata API fallisce, così l'utente viene reindirizzato al login invece di vedere pagine bloccate o falsi successi.

**Architecture:** Introdurre un helper `apiFetch` locale dentro il componente `App()` (stesso stile del resto del file: nessun modulo esterno, nessun client HTTP centralizzato preesistente) che allega l'header `Authorization`, intercetta `res.status === 401` chiamando `handleLogout()` e lancia un errore tipizzato `ApiAuthError`. I call site rotti vengono migrati a usare `apiFetch` e a interrompere silenziosamente (senza alert ridondanti) quando ricevono `ApiAuthError`, dato che il redirect al login avviene già tramite `setToken(null)` → `if (!token)` a `App.tsx:2071`.

**Tech Stack:** React 19 + TypeScript, nessun test runner configurato per frontend-admin (`"test": "echo 'no tests'"` in `package.json`) — verifica tramite `tsc --noEmit` + test manuale nel browser via Docker, come da CLAUDE.md.

## Global Constraints

- Nessun modulo/libreria nuovo: `apiFetch` va definito come funzione locale dentro `App()`, non in un file separato — il codebase non ha precedenti di client HTTP centralizzato, seguire lo stile esistente (tutti gli handler colocati in `App.tsx`).
- Non toccare `runNotificationSearch` (bug ricerca notifiche) né altri fetch non elencati nei task: è materia di un piano separato già concordato con l'utente.
- Verifica frontend: SEMPRE `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit` (mai `tsc -b`, fallisce nel container per errori `@types/node` preesistenti — vedi CLAUDE.md).
- Test manuale nel browser obbligatorio per ogni task (dev server Vite, hot reload automatico): login, azione, verifica comportamento; poi simulare token scaduto cancellando `comunicapa_token` da `localStorage` (DevTools → Application → Local Storage) e ripetere l'azione — deve comparire la schermata di login, non un errore silenzioso.
- Ogni commit tocca solo `apps/frontend-admin/src/App.tsx`.

---

## Contesto — evidenza raccolta

Log console incollato dall'utente mostra 401 su: `GET /notifications-search`, `GET /campaigns/:id`, `GET /campaigns/:id/failures`, `POST /campaigns`, `PUT /settings` (x2), tutti con body HTML (`<!DOCTYPE`) invece di JSON — il body HTML arriva da un layer a monte del backend NestJS (proxy/ingress esterno non versionato nel repo), non da un bug nel guard JWT (i commit recenti `8ff808c`/`e57a9d2`/`687dd16` toccano solo il percorso cittadino/OIDC, invariato lato operatore).

Causa applicativa: `apps/frontend-admin/src/App.tsx` non ha un client HTTP centralizzato — ogni handler fa `fetch()` manuale, e la maggior parte non controlla mai `res.status === 401`. Risultato: quando il token scade, l'utente resta "loggato" in apparenza ma ogni azione fallisce in modo silenzioso o con messaggi fuorvianti invece di essere reindirizzato al login.

Bug confermati per questo piano (bloccanti, gruppo scelto dall'utente):

1. **Salva bozza campagna** — `handleSaveWizardDraft` (righe ~1676-1715): sia il `POST /campaigns` (bozza nuova) sia il `PATCH /campaigns/:id` (bozza esistente) non controllano 401, lanciano solo un `Error` generico "Errore durante il salvataggio della bozza" — confermato dal log (`POST /campaigns 401` x2).
2. **Dettaglio/esiti campagna in coda** — `fetchCampaignDetail` (riga ~489) e `fetchCampaignFailures` (riga ~506): nessun controllo 401; il primo lancia errore generico, il secondo fallisce del tutto silenziosamente (`if (res.ok) ...` senza `else`) — confermato dal log (`GET /campaigns/:id`, `GET /campaigns/:id/failures` 401).
3. **Salva impostazioni generali** — `handleSaveSettings` (righe ~753-798): su 401 il body è HTML, `res.json()` lancia `SyntaxError`, catturato dal blocco `catch` esterno che mostra "Errore di rete durante il salvataggio." — messaggio fuorviante che nasconde il vero problema (token scaduto) — confermato dal log (`PUT /settings 401` x2).
4. **Salva servizio App IO** — `handleAddIoService` (righe ~670-701): **non controlla affatto `res.ok`** — dopo qualunque fetch (successo, 401, 500, errore di validazione) esegue comunque `fetchIoServices()` e mostra "Servizio creato con successo!". Non presente nel log incollato (trovato da audit del codice), ma coerente con la lamentela "non è possibile salvare servizio App IO": l'utente non vede mai un errore reale, solo un falso successo seguito dall'assenza del servizio in lista.

---

### Task 1: Helper `apiFetch` centralizzato

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:457-465` (subito dopo `handleLogout`)

**Interfaces:**
- Produces: `class ApiAuthError extends Error` — usata dai task successivi con `if (err instanceof ApiAuthError) return;` nei blocchi `catch`.
- Produces: `const apiFetch = async (path: string, init?: RequestInit): Promise<Response>` — chiama `${API_BASE}${path}`, allega `Authorization: Bearer ${token}` (variabile `token` già in scope come stato del componente), su `res.status === 401` chiama `handleLogout()` e lancia `new ApiAuthError()`, altrimenti ritorna la `Response` (anche se `!res.ok` per altri status — il chiamante resta responsabile di controllare `res.ok` per 4xx/5xx diversi da 401).
- Consumes: `token` (stato `useState<string | null>`, riga 107), `handleLogout` (riga 457), `API_BASE` (riga 11) — tutti già definiti nello scope di `App()`.

- [ ] **Step 1: Aggiungi `ApiAuthError` e `apiFetch` dopo `handleLogout`**

In `apps/frontend-admin/src/App.tsx`, subito dopo la chiusura di `handleLogout` (riga 465, `};`), inserisci:

```tsx
  class ApiAuthError extends Error {
    constructor() {
      super('Sessione scaduta. Effettua nuovamente il login.');
      this.name = 'ApiAuthError';
    }
  }

  const apiFetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
    if (res.status === 401) {
      handleLogout();
      throw new ApiAuthError();
    }
    return res;
  };
```

- [ ] **Step 2: Verifica compilazione TypeScript**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore (0 output, exit code 0). `class` dentro un componente funzione è legale in TS/JS (viene ridefinita a ogni render, coerente con `apiFetch` che cattura `token` per closure).

- [ ] **Step 3: Verifica manuale — nessuna regressione al login**

Con `docker compose up -d` già attivo, apri `http://localhost:3000`, fai login (admin/admin se `LDAP_HOST=mock`). Verifica che la dashboard carichi come prima (questo step non usa ancora `apiFetch`, serve solo a confermare che l'aggiunta non rompe il render).

- [ ] **Step 4: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): aggiungi apiFetch centralizzato con gestione 401"
```

---

### Task 2: Fix dettaglio ed esiti campagna in coda

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:489-509` (`fetchCampaignDetail`, `fetchCampaignFailures`)

**Interfaces:**
- Consumes: `apiFetch`, `ApiAuthError` (Task 1).
- Produces: nessuna nuova interfaccia — comportamento invariato per i chiamanti (`fetchCampaignDetail(id)`, `fetchCampaignFailures(campaignId)` restano `async` senza return value usato altrove).

- [ ] **Step 1: Sostituisci `fetchCampaignDetail`**

Trova (righe ~489-504):

```tsx
  const fetchCampaignDetail = async (id: string) => {
    setLoadingCampaignDetail(true);
    setDetailError(null);
    try {
      const res = await fetch(`${API_BASE}/campaigns/${id}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Impossibile caricare il dettaglio della campagna.');
      const data = await res.json();
      setCampaign(data);
    } catch (err: any) {
      setDetailError(err.message);
    } finally {
      setLoadingCampaignDetail(false);
    }
  };
```

Sostituisci con:

```tsx
  const fetchCampaignDetail = async (id: string) => {
    setLoadingCampaignDetail(true);
    setDetailError(null);
    try {
      const res = await apiFetch(`/campaigns/${id}`);
      if (!res.ok) throw new Error('Impossibile caricare il dettaglio della campagna.');
      const data = await res.json();
      setCampaign(data);
    } catch (err: any) {
      if (err instanceof ApiAuthError) return;
      setDetailError(err.message);
    } finally {
      setLoadingCampaignDetail(false);
    }
  };
```

- [ ] **Step 2: Sostituisci `fetchCampaignFailures`**

Trova (riga ~506-509):

```tsx
  const fetchCampaignFailures = async (campaignId: string) => {
    const res = await fetch(`${API_BASE}/campaigns/${campaignId}/failures`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setCampaignFailures(await res.json());
  };
```

Sostituisci con:

```tsx
  const fetchCampaignFailures = async (campaignId: string) => {
    try {
      const res = await apiFetch(`/campaigns/${campaignId}/failures`);
      if (res.ok) setCampaignFailures(await res.json());
    } catch (err) {
      if (err instanceof ApiAuthError) return;
      throw err;
    }
  };
```

- [ ] **Step 3: Verifica compilazione**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 4: Verifica manuale — campagna in coda con token valido**

Login, apri una campagna con stato `queued`/`running` dalla dashboard (click su riga campagna). Verifica che dettaglio ed esiti carichino normalmente (nessuna regressione).

- [ ] **Step 5: Verifica manuale — token scaduto**

Con la campagna aperta, in DevTools → Application → Local Storage, cancella `comunicapa_token`. Ricarica la pagina (F5) o riapri la campagna dalla lista. Expected: l'app mostra la schermata di login invece di un dettaglio vuoto/bloccato o errori silenziosi in console.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "fix(frontend-admin): redirect a login su 401 aprendo campagna in coda"
```

---

### Task 3: Fix salvataggio bozza campagna

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:1676-1717` (`handleSaveWizardDraft`)

**Interfaces:**
- Consumes: `apiFetch`, `ApiAuthError` (Task 1).

- [ ] **Step 1: Sostituisci `handleSaveWizardDraft`**

Trova (righe ~1676-1717, verifica i confini esatti leggendo il file — il blocco termina con `setWizDraftSaving(false); }`):

```tsx
  const handleSaveWizardDraft = async () => {
    if (!wizName) {
      alert('Inserisci almeno il nome della campagna prima di salvare la bozza.');
      return;
    }
    setWizDraftSaving(true);
    try {
      if (!wizCampaignId) {
        const res = await fetch(`${API_BASE}/campaigns`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            name: wizName,
            description: wizDesc,
            channelType: wizChannel,
            channelConfig: buildWizChannelConfigDraft(),
          }),
        });
        if (!res.ok) throw new Error('Errore durante il salvataggio della bozza');
        const created = await res.json();
        setWizCampaignId(created.id);
      } else {
        const res = await fetch(`${API_BASE}/campaigns/${wizCampaignId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            name: wizName,
            description: wizDesc,
            channelConfig: buildWizChannelConfigDraft(),
          }),
        });
        if (!res.ok) throw new Error('Errore durante il salvataggio della bozza');
      }
      fetchCampaigns();
      alert('Bozza salvata.');
    } catch (err: any) {
      alert(err.message);
    } finally {
      setWizDraftSaving(false);
    }
  };
```

Sostituisci con:

```tsx
  const handleSaveWizardDraft = async () => {
    if (!wizName) {
      alert('Inserisci almeno il nome della campagna prima di salvare la bozza.');
      return;
    }
    setWizDraftSaving(true);
    try {
      if (!wizCampaignId) {
        const res = await apiFetch('/campaigns', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: wizName,
            description: wizDesc,
            channelType: wizChannel,
            channelConfig: buildWizChannelConfigDraft(),
          }),
        });
        if (!res.ok) throw new Error('Errore durante il salvataggio della bozza');
        const created = await res.json();
        setWizCampaignId(created.id);
      } else {
        const res = await apiFetch(`/campaigns/${wizCampaignId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: wizName,
            description: wizDesc,
            channelConfig: buildWizChannelConfigDraft(),
          }),
        });
        if (!res.ok) throw new Error('Errore durante il salvataggio della bozza');
      }
      fetchCampaigns();
      alert('Bozza salvata.');
    } catch (err: any) {
      if (err instanceof ApiAuthError) return;
      alert(err.message);
    } finally {
      setWizDraftSaving(false);
    }
  };
```

- [ ] **Step 2: Verifica compilazione**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 3: Verifica manuale — salvataggio bozza con token valido**

Login, apri wizard invio massivo, compila nome campagna, click "Salva bozza". Expected: alert "Bozza salvata.", campagna compare in dashboard con stato `draft`.

- [ ] **Step 4: Verifica manuale — token scaduto**

Nel wizard, cancella `comunicapa_token` da Local Storage (DevTools), click "Salva bozza". Expected: schermata di login, nessun alert d'errore generico residuo.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "fix(frontend-admin): redirect a login su 401 salvando bozza campagna"
```

---

### Task 4: Fix salvataggio impostazioni generali

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:753-798` (`handleSaveSettings`)

**Interfaces:**
- Consumes: `apiFetch`, `ApiAuthError` (Task 1).

- [ ] **Step 1: Sostituisci `handleSaveSettings`**

Trova (righe ~753-798):

```tsx
  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    // Canali non ancora migrati al backend: restano su localStorage
    // (App IO ora persistito lato server via /io-services, niente più localStorage)
    localStorage.setItem('sett_proto_provider', settProtoProvider);
    localStorage.setItem('sett_proto_url', settProtoUrl);
    localStorage.setItem('sett_proto_user', settProtoUser);
    localStorage.setItem('sett_proto_pass', settProtoPass);
    localStorage.setItem('sett_postal_provider', settPostalProvider);
    localStorage.setItem('sett_postal_key', settPostalKey);
    localStorage.setItem('sett_postal_url', settPostalUrl);

    try {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          settings: {
            'brand.name': settEntityName,
            'brand.subtitle': settSubtitle,
            'brand.logo': settLogoValue,
            'brand.favicon': settFaviconValue,
            // SMTP and PEC are saved via their own endpoints; App IO via /io-services
            'send.apiKey': settSendApiKey,
            'send.baseUrl': settSendUrl,
            'retention.maxDays': Number(settRetentionDays) || 90,
            'oidc.issuer': settOidcIssuer,
            'oidc.audience': settOidcAudience,
            'oidc.jwksUri': settOidcJwksUri,
            'oidc.clientId': settOidcClientId,
            'oidc.clientSecret': settOidcClientSecret,
            'oidc.logoutUrl': settOidcLogoutUrl,
          },
        }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { message?: string };
        setSettingsSavedMessage({ text: `Errore salvataggio: ${err.message ?? res.status}`, error: true });
      } else {
        setSettingsSavedMessage({ text: 'Impostazioni salvate con successo!', error: false });
      }
    } catch {
      setSettingsSavedMessage({ text: 'Errore di rete durante il salvataggio.', error: true });
    }
    setTimeout(() => setSettingsSavedMessage(null), 3000);
  };
```

Sostituisci con:

```tsx
  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    // Canali non ancora migrati al backend: restano su localStorage
    // (App IO ora persistito lato server via /io-services, niente più localStorage)
    localStorage.setItem('sett_proto_provider', settProtoProvider);
    localStorage.setItem('sett_proto_url', settProtoUrl);
    localStorage.setItem('sett_proto_user', settProtoUser);
    localStorage.setItem('sett_proto_pass', settProtoPass);
    localStorage.setItem('sett_postal_provider', settPostalProvider);
    localStorage.setItem('sett_postal_key', settPostalKey);
    localStorage.setItem('sett_postal_url', settPostalUrl);

    try {
      const res = await apiFetch('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: {
            'brand.name': settEntityName,
            'brand.subtitle': settSubtitle,
            'brand.logo': settLogoValue,
            'brand.favicon': settFaviconValue,
            // SMTP and PEC are saved via their own endpoints; App IO via /io-services
            'send.apiKey': settSendApiKey,
            'send.baseUrl': settSendUrl,
            'retention.maxDays': Number(settRetentionDays) || 90,
            'oidc.issuer': settOidcIssuer,
            'oidc.audience': settOidcAudience,
            'oidc.jwksUri': settOidcJwksUri,
            'oidc.clientId': settOidcClientId,
            'oidc.clientSecret': settOidcClientSecret,
            'oidc.logoutUrl': settOidcLogoutUrl,
          },
        }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { message?: string };
        setSettingsSavedMessage({ text: `Errore salvataggio: ${err.message ?? res.status}`, error: true });
      } else {
        setSettingsSavedMessage({ text: 'Impostazioni salvate con successo!', error: false });
      }
    } catch (err) {
      if (err instanceof ApiAuthError) return;
      setSettingsSavedMessage({ text: 'Errore di rete durante il salvataggio.', error: true });
    }
    setTimeout(() => setSettingsSavedMessage(null), 3000);
  };
```

- [ ] **Step 2: Verifica compilazione**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 3: Verifica manuale — salvataggio impostazioni con token valido**

Login, vai su Impostazioni, modifica un campo (es. nome ente), click salva. Expected: messaggio "Impostazioni salvate con successo!".

- [ ] **Step 4: Verifica manuale — token scaduto**

Nella pagina Impostazioni, cancella `comunicapa_token` da Local Storage, click salva. Expected: schermata di login, non più il messaggio fuorviante "Errore di rete durante il salvataggio."

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "fix(frontend-admin): redirect a login su 401 salvando impostazioni"
```

---

### Task 5: Fix salvataggio servizio App IO

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:670-701` (`handleAddIoService`), `apps/frontend-admin/src/App.tsx:914-925` (`fetchIoServices`)

**Interfaces:**
- Consumes: `apiFetch`, `ApiAuthError` (Task 1).

- [ ] **Step 1: Sostituisci `handleAddIoService`**

Trova (righe ~670-701):

```tsx
  const handleAddIoService = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSvcNome || !newSvcIdService || !newSvcApiKeyPrimaria) {
      alert('I campi contrassegnati con asterisco sono obbligatori.');
      return;
    }
    await fetch(`${API_BASE}/io-services`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        nome: newSvcNome,
        idService: newSvcIdService.toUpperCase().trim(),
        descrizione: newSvcDesc,
        apiKeyPrimaria: newSvcApiKeyPrimaria,
        apiKeySecondaria: newSvcApiKeySecondaria,
        codiceCatalogo: newSvcCodiceCatalogo,
        isDefault: newSvcIsDefault || ioServices.length === 0,
      }),
    });
    await fetchIoServices();

    // Reset Form
    setNewSvcNome('');
    setNewSvcIdService('');
    setNewSvcDesc('');
    setNewSvcApiKeyPrimaria('');
    setNewSvcApiKeySecondaria('');
    setNewSvcCodiceCatalogo('');
    setNewSvcIsDefault(false);
    setShowNewSvcForm(false);
    alert('Servizio creato con successo!');
  };
```

Sostituisci con:

```tsx
  const handleAddIoService = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSvcNome || !newSvcIdService || !newSvcApiKeyPrimaria) {
      alert('I campi contrassegnati con asterisco sono obbligatori.');
      return;
    }
    try {
      const res = await apiFetch('/io-services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nome: newSvcNome,
          idService: newSvcIdService.toUpperCase().trim(),
          descrizione: newSvcDesc,
          apiKeyPrimaria: newSvcApiKeyPrimaria,
          apiKeySecondaria: newSvcApiKeySecondaria,
          codiceCatalogo: newSvcCodiceCatalogo,
          isDefault: newSvcIsDefault || ioServices.length === 0,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Errore durante la creazione del servizio App IO.');
      }
      await fetchIoServices();

      // Reset Form
      setNewSvcNome('');
      setNewSvcIdService('');
      setNewSvcDesc('');
      setNewSvcApiKeyPrimaria('');
      setNewSvcApiKeySecondaria('');
      setNewSvcCodiceCatalogo('');
      setNewSvcIsDefault(false);
      setShowNewSvcForm(false);
      alert('Servizio creato con successo!');
    } catch (err: any) {
      if (err instanceof ApiAuthError) return;
      alert(err.message || 'Errore durante la creazione del servizio App IO.');
    }
  };
```

- [ ] **Step 2: Sostituisci `fetchIoServices`**

Trova (righe ~914-925):

```tsx
  const fetchIoServices = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/io-services`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        setIoServices(data.configs || []);
      }
    } catch (err) {
      console.error("Errore caricamento io-services:", err);
    }
  };
```

Sostituisci con:

```tsx
  const fetchIoServices = async () => {
    if (!token) return;
    try {
      const res = await apiFetch('/io-services');
      if (res.ok) {
        const data = await res.json();
        setIoServices(data.configs || []);
      }
    } catch (err) {
      if (err instanceof ApiAuthError) return;
      console.error("Errore caricamento io-services:", err);
    }
  };
```

- [ ] **Step 3: Verifica compilazione**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 4: Verifica manuale — creazione servizio App IO con token valido**

Login, vai su Impostazioni → Servizi App IO, compila nome/idService/apiKeyPrimaria, click "Aggiungi". Expected: alert "Servizio creato con successo!" E il servizio compare davvero nella lista sotto.

- [ ] **Step 5: Verifica manuale — errore di validazione reale (non 401)**

Compila con un `idService` duplicato di uno già esistente (se il backend valida unicità) o lascia un campo obbligatorio mancante lato client rimosso temporaneamente per testare la risposta server. Expected: alert con messaggio di errore reale del backend, NON "Servizio creato con successo!", e il servizio non deve comparire in lista se il backend l'ha rifiutato.

- [ ] **Step 6: Verifica manuale — token scaduto**

Cancella `comunicapa_token` da Local Storage, prova ad aggiungere un servizio App IO. Expected: schermata di login.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "fix(frontend-admin): controlla esito reale e 401 salvando servizio App IO"
```

---

## Note per i prossimi piani (non in scope qui)

- `runNotificationSearch` (ricerca notifiche) ha lo stesso problema (nessun controllo 401/`res.ok`, crash silenzioso su body HTML) — resta rotto finché non si esegue il piano dedicato a "dettaglio pendenza + ricerca notifiche".
- Il body HTML (`<!DOCTYPE`) sui 401 in produzione arriva da un layer esterno al repo (proxy/ingress del Comune) non da NestJS: se si vuole un messaggio d'errore più preciso lato utente in futuro, andrebbe indagato quel layer — fuori scope per un fix lato frontend.
- Altri handler App IO (`handleSetDefaultIoService`, `handleDeleteIoService`, `handleTestIoService`, righe ~703-750) hanno la stessa debolezza (fetch diretto, non tutti controllano 401) ma non sono stati segnalati come bug — valutare se includerli in un piano di pulizia generale di `apiFetch` su tutto il file.
