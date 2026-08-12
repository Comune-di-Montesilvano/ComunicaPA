# Override admin individuale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettere di promuovere un singolo operatore LDAP a `admin` tramite env var, indipendentemente dal suo gruppo AD.

**Architecture:** Nuova chiave bootstrap-only `ldap.adminUsernames` (CSV → array lowercase) in `configuration.ts`, letta da `LdapService` sia nel branch AD reale sia nel branch mock; se lo username autenticato è nella lista, il ruolo risultante è sempre `admin` (solo promozione, mai degrado di un admin-by-group).

**Tech Stack:** NestJS `ConfigService`, Jest.

## Global Constraints

- Bootstrap-only: nessuna tabella DB, nessuna UI — solo `.env`/`configuration.ts` (spec: "Configurazione runtime" in CLAUDE.md, stesso principio già in vigore per `ldap.adminGroup`).
- Solo promozione, mai degrado: un `admin` da gruppo AD resta `admin` anche se non in `LDAP_ADMIN_USERNAMES`.
- Confronto username case-insensitive.
- Stesso comportamento in modalità mock (`LDAP_HOST=mock`) e reale.

---

### Task 1: config key `ldap.adminUsernames`

**Files:**
- Modify: `apps/backend/src/config/configuration.ts:14-24` (interface `AppConfiguration.ldap`), `:46-56` (default export)

**Interfaces:**
- Produces: `AppConfiguration.ldap.adminUsernames: string[]` — array di username in lowercase, trimmati, senza voci vuote. Consumato da `LdapService` (Task 2).

- [ ] **Step 1: Aggiungi il campo all'interfaccia**

In `apps/backend/src/config/configuration.ts`, dentro l'interfaccia `ldap` (dopo `adminGroup: string;` alla riga 23):

```ts
  ldap: {
    host: string;
    baseDn: string;
    userDnTemplate: string;
    tlsSkipVerify: boolean;
    startTls: boolean;
    bindDn: string;
    bindPassword: string;
    requiredGroup: string;
    adminGroup: string;
    adminUsernames: string[];
  };
```

- [ ] **Step 2: Popola il default export**

Nel blocco `ldap: {...}` dell'export default (dopo `adminGroup: process.env['LDAP_ADMIN_GROUP'] ?? 'COMUNICAPA_ADMINS',` alla riga 55):

```ts
    adminGroup: process.env['LDAP_ADMIN_GROUP'] ?? 'COMUNICAPA_ADMINS',
    adminUsernames: (process.env['LDAP_ADMIN_USERNAMES'] ?? '')
      .split(',')
      .map((u) => u.trim().toLowerCase())
      .filter((u) => u.length > 0),
```

- [ ] **Step 3: Verifica compilazione**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun nuovo errore (se il backend dev non è già in esecuzione, avviarlo prima con `docker compose up -d backend`).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/config/configuration.ts
git commit -m "feat(auth): aggiungi config ldap.adminUsernames

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: applica override in `LdapService`

**Files:**
- Modify: `apps/backend/src/auth/ldap/ldap.service.ts:19-63` (branch mock e reale), `:136-137` (calcolo `role`)
- Test: `apps/backend/src/auth/ldap/ldap.service.spec.ts`

**Interfaces:**
- Consumes: `AppConfiguration.ldap.adminUsernames: string[]` (Task 1), letto via `this.config.get('ldap.adminUsernames', { infer: true }) ?? []` (fallback `[]` per i mock di test che non valorizzano la chiave).

- [ ] **Step 1: Scrivi il test fallente — promozione via override, branch AD reale**

In `apps/backend/src/auth/ldap/ldap.service.spec.ts`, prima nella funzione `buildService`, aggiungi supporto a un parametro opzionale `adminUsernames`:

```ts
async function buildService(host: string, adminUsernames: string[] = []): Promise<LdapService> {
  const module = await Test.createTestingModule({
    providers: [
      LdapService,
      {
        provide: ConfigService,
        useValue: {
          get: (key: string) => {
            const cfg: Record<string, unknown> = {
              'ldap.host': host,
              'ldap.baseDn': 'DC=test,DC=local',
              'ldap.userDnTemplate': '%s@test.local',
              'ldap.tlsSkipVerify': true,
              'ldap.adminGroup': 'COMUNICAPA_ADMINS',
              'ldap.requiredGroup': 'COMUNICAPA_USERS',
              'ldap.adminUsernames': adminUsernames,
            };
            return cfg[key];
          },
        },
      },
    ],
  }).compile();
  return module.get<LdapService>(LdapService);
}
```

Poi aggiungi il nuovo test, dopo il test `'should resolve with role=user using recursive membership check...'` (dopo la riga 158):

```ts
  it('should promote to role=admin via LDAP_ADMIN_USERNAMES override even if not in admin group', async () => {
    service = await buildService('ldap://localhost:389', ['mario.rossi']);

    mockClient.bind.mockImplementation(
      (_dn: string, _pw: string, cb: (err: null) => void) => cb(null),
    );

    const mockSearchRes = {
      on: jest.fn().mockImplementation(function (
        this: typeof mockSearchRes,
        event: string,
        cb: (...args: unknown[]) => void,
      ) {
        if (event === 'searchEntry') {
          cb({
            object: {
              sAMAccountName: 'mario.rossi',
              displayName: 'Mario Rossi',
              memberOf: ['CN=COMUNICAPA_USERS,OU=Groups,DC=test,DC=local'],
            },
          });
        }
        if (event === 'end') {
          cb({ status: 0 });
        }
        return this;
      }),
    };

    mockClient.search.mockImplementation(
      (
        _base: string,
        _opts: unknown,
        cb: (err: null, res: typeof mockSearchRes) => void,
      ) => cb(null, mockSearchRes),
    );

    const result = await service.authenticate('mario.rossi', 'password123');

    expect(result.role).toBe('admin');
  });

  it('should match LDAP_ADMIN_USERNAMES case-insensitively', async () => {
    service = await buildService('ldap://localhost:389', ['MARIO.ROSSI']);

    mockClient.bind.mockImplementation(
      (_dn: string, _pw: string, cb: (err: null) => void) => cb(null),
    );

    const mockSearchRes = {
      on: jest.fn().mockImplementation(function (
        this: typeof mockSearchRes,
        event: string,
        cb: (...args: unknown[]) => void,
      ) {
        if (event === 'searchEntry') {
          cb({
            object: {
              sAMAccountName: 'mario.rossi',
              displayName: 'Mario Rossi',
              memberOf: ['CN=COMUNICAPA_USERS,OU=Groups,DC=test,DC=local'],
            },
          });
        }
        if (event === 'end') {
          cb({ status: 0 });
        }
        return this;
      }),
    };

    mockClient.search.mockImplementation(
      (
        _base: string,
        _opts: unknown,
        cb: (err: null, res: typeof mockSearchRes) => void,
      ) => cb(null, mockSearchRes),
    );

    const result = await service.authenticate('mario.rossi', 'password123');

    expect(result.role).toBe('admin');
  });
```

Aggiungi anche, dentro `describe('mock mode (LDAP_HOST=mock)', ...)` (dopo il test `'accepts operator/operator with role=user'`, riga 197):

```ts
    it('promotes operator to role=admin via LDAP_ADMIN_USERNAMES override', async () => {
      service = await buildService('mock', ['operator']);
      const result = await service.authenticate('operator', 'operator');
      expect(result.role).toBe('admin');
    });
```

- [ ] **Step 2: Esegui i test, verifica che i 3 nuovi falliscano**

Run: `docker compose exec backend node_modules/.bin/jest ldap.service.spec --maxWorkers=2`
Expected: FAIL sui 3 nuovi test (`expect(result.role).toBe('admin')` riceve `'user'`), gli altri test esistenti restano PASS.

- [ ] **Step 3: Implementa l'override nel branch mock**

In `apps/backend/src/auth/ldap/ldap.service.ts`, modifica `authenticate()` (righe 19-40):

```ts
  async authenticate(username: string, password: string): Promise<LdapUser> {
    const host = this.config.get('ldap.host', { infer: true });
    const adminUsernames = this.config.get('ldap.adminUsernames', { infer: true }) ?? [];
    const isAdminOverride = adminUsernames.includes(username.toLowerCase());

    // Credenziali simulate SOLO in sviluppo locale (LDAP_HOST=mock):
    // con un host reale non esiste alcun bypass
    if (host === 'mock') {
      if (username === 'admin' && password === 'admin') {
        return {
          username: 'admin',
          displayName: 'Amministratore Simulato',
          role: 'admin',
        };
      }
      if (username === 'operator' && password === 'operator') {
        return {
          username: 'operator',
          displayName: 'Operatore Simulato',
          role: isAdminOverride ? 'admin' : 'user',
        };
      }
      throw new UnauthorizedException('Credenziali non valide');
    }
```

Il resto del metodo (righe 41-63) resta invariato.

- [ ] **Step 4: Implementa l'override nel branch AD reale**

Nello stesso file, modifica il calcolo di `role` in `connectAndAuthenticate()` (riga 137):

```ts
      const adminUsernames = this.config.get('ldap.adminUsernames', { infer: true }) ?? [];
      const isAdminOverride = adminUsernames.includes(opts.username.toLowerCase());
      if (isAdminOverride && !isAdmin) {
        this.logger.log(
          `Override admin individuale applicato per ${opts.username} (LDAP_ADMIN_USERNAMES)`,
        );
      }
      const role: OperatorRole = (isAdmin || isAdminOverride) ? 'admin' : 'user';
```

Sostituisce la riga esistente `const role: OperatorRole = isAdmin ? 'admin' : 'user';`.

- [ ] **Step 5: Esegui i test, verifica che tutti passino**

Run: `docker compose exec backend node_modules/.bin/jest ldap.service.spec --maxWorkers=2`
Expected: PASS su tutti i test (esistenti + 3 nuovi).

- [ ] **Step 6: Suite completa backend (baseline check)**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: stesso failure set noto (solo `app.controller.spec.ts` `isLdapMock`), nessuna nuova regressione.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/auth/ldap/ldap.service.ts apps/backend/src/auth/ldap/ldap.service.spec.ts
git commit -m "feat(auth): promuovi admin individuale via LDAP_ADMIN_USERNAMES

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: documentazione `.env.example`

**Files:**
- Modify: `.env.example:75` (dopo `LDAP_ADMIN_GROUP=COMUNICAPA_ADMINS`)

**Interfaces:**
- Nessuna (solo documentazione).

- [ ] **Step 1: Aggiungi la riga commentata**

In `.env.example`, dopo la riga 75 (`LDAP_ADMIN_GROUP=COMUNICAPA_ADMINS`):

```
# Promuove singoli username ad admin indipendentemente dal gruppo AD (CSV,
# case-insensitive). Solo promozione: un admin-by-group resta admin anche
# se assente da questa lista. Bootstrap-only, richiede restart backend.
# LDAP_ADMIN_USERNAMES=mrossi,jbianchi
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs: documenta LDAP_ADMIN_USERNAMES in .env.example

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Verifica finale end-to-end (manuale, dev)

- [ ] **Step 1: Aggiungi la var e riavvia il backend**

In `.env` locale (dev, `LDAP_HOST=mock`): aggiungi `LDAP_ADMIN_USERNAMES=operator`, poi:

Run: `docker compose restart backend`

- [ ] **Step 2: Login come operator, verifica ruolo admin**

Run:
```bash
docker compose exec backend node -e "
fetch('http://localhost:8080/admin/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'operator', password: 'operator' }),
})
  .then((r) => r.json())
  .then((body) => console.log(JSON.stringify(body)));
"
```
Expected: risposta 200 con `role: 'admin'` (`AuthResponseDto.role`, endpoint confermato: `AuthController.login()`, `apps/backend/src/auth/auth.controller.ts:13`).
