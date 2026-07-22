# ANPR indirizzo estero (AIRE) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Il pannello "Verifica Anagrafica" mostra l'indirizzo estero (AIRE) invece di una card vuota quando ANPR restituisce `residenza[0].localitaEstera` invece di `.indirizzo`.

**Architecture:** Estendere i tipi ANPR (backend e frontend, pass-through già esistente) con il campo opzionale `localitaEstera`, poi diramare il rendering del pannello su tre casi: indirizzo IT, indirizzo estero, nessun indirizzo.

**Tech Stack:** NestJS/TypeScript (backend), React 19/TypeScript (frontend-admin).

## Global Constraints

- Nessuna nuova chiamata API, nessuna modifica a `DomicilioService`/`domicilio.controller.ts` (pass-through già presente).
- Nessuna modifica a invio singolo, POSTAL, SEND — fuori scope (spec `2026-07-22-anpr-indirizzo-estero-design.md`).
- Type-check backend (`docker compose exec backend node_modules/.bin/tsc --noEmit`) e frontend-admin (`docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`) devono restare puliti dopo ogni task.

---

### Task 1: Tipo `AnprLocalitaEstera` nel backend

**Files:**
- Modify: `apps/backend/src/channels/anpr/anpr.types.ts`

**Interfaces:**
- Produces: `AnprLocalitaEstera` (nuovo export), campo `localitaEstera?: AnprLocalitaEstera` aggiunto su `AnprResidenza`.

- [ ] **Step 1: Aggiungere il tipo e il campo**

In `apps/backend/src/channels/anpr/anpr.types.ts`, dopo l'interfaccia `AnprResidenza` esistente (righe 26-31), aggiungere:

```ts
export interface AnprLocalitaEstera {
  consolato?: { codiceConsolato?: string; descrizioneConsolato?: string };
  indirizzoEstero?: {
    cap?: string;
    localita?: { codiceStato?: string; descrizioneLocalita?: string; descrizioneStato?: string };
    toponimo?: { denominazione?: string; numeroCivico?: string };
  };
}
```

E modificare `AnprResidenza` aggiungendo il campo:

```ts
export interface AnprResidenza {
  tipoIndirizzo?: string;
  indirizzo?: AnprIndirizzo;
  localitaEstera?: AnprLocalitaEstera;
  dataDecorrenzaResidenza?: string;
  presso?: string;
}
```

- [ ] **Step 2: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore (nessun consumatore esistente rotto, campo è opzionale e additivo).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/channels/anpr/anpr.types.ts
git commit -m "$(cat <<'EOF'
feat(backend): tipo AnprLocalitaEstera per residenza AIRE

ANPR C002 restituisce residenza[0].localitaEstera (consolato +
indirizzoEstero) invece di .indirizzo per soggetti AIRE — campo non
modellato finora, il JSON grezzo lo conteneva già ma passava
attraverso i tipi come proprietà sconosciuta.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Tipo frontend + rendering pannello "Verifica Anagrafica"

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx:907` (tipo stato `verificaAnprResult` o equivalente — vedi blocco righe 900-911)
- Modify: `apps/frontend-admin/src/App.tsx:9973-9988` (card "Indirizzo Fisico (ANPR)")

**Interfaces:**
- Consumes: `AnprLocalitaEstera` shape da Task 1 (stesso JSON, il frontend ha un tipo locale duplicato — non importa dal backend, pattern esistente in questo file per lo stato `anpr`).
- Produces: nessuna nuova interfaccia esportata — solo rendering.

- [ ] **Step 1: Estendere il tipo locale del campo `residenza`**

In `apps/frontend-admin/src/App.tsx` riga 907, sostituire:

```ts
      residenza?: Array<{ dataDecorrenzaResidenza?: string; indirizzo?: { cap?: string; comune?: { nomeComune?: string; siglaProvinciaIstat?: string; siglaProvincia?: string; provincia?: string }; toponimo?: { specie?: string; denominazioneToponimo?: string }; numeroCivico?: { numero?: string; lettera?: string } } }>;
```

con:

```ts
      residenza?: Array<{
        dataDecorrenzaResidenza?: string;
        indirizzo?: { cap?: string; comune?: { nomeComune?: string; siglaProvinciaIstat?: string; siglaProvincia?: string; provincia?: string }; toponimo?: { specie?: string; denominazioneToponimo?: string }; numeroCivico?: { numero?: string; lettera?: string } };
        localitaEstera?: {
          consolato?: { descrizioneConsolato?: string };
          indirizzoEstero?: { cap?: string; localita?: { descrizioneLocalita?: string; descrizioneStato?: string }; toponimo?: { denominazione?: string; numeroCivico?: string } };
        };
      }>;
```

- [ ] **Step 2: Diramare il rendering della card**

In `apps/frontend-admin/src/App.tsx`, righe 9973-9988, sostituire il blocco:

```tsx
                            {anpr.success && anpr.found && anpr.residenza?.[0] && (() => {
                              const resComune = anpr.residenza[0].indirizzo?.comune;
                              const resProv = resComune?.siglaProvinciaIstat ?? (resComune as any)?.siglaProvincia ?? (resComune as any)?.provincia;
                              return (
                                <div className="small">
                                  <div className="fw-bold text-dark mb-1">
                                    {anpr.residenza[0].indirizzo?.toponimo?.specie} {anpr.residenza[0].indirizzo?.toponimo?.denominazioneToponimo}
                                    {anpr.residenza[0].indirizzo?.numeroCivico?.numero ? `, ${anpr.residenza[0].indirizzo.numeroCivico.numero}${anpr.residenza[0].indirizzo.numeroCivico.lettera ?? ''}` : ''}
                                  </div>
                                  <div className="text-muted">
                                    {anpr.residenza[0].indirizzo?.cap} {resComune?.nomeComune} {resProv ? `(${resProv})` : ''}
                                  </div>
                                </div>
                              );
                            })()}
                            {anpr.success && anpr.found && !anpr.residenza?.[0] && <p className="small text-muted mb-0">Nessun indirizzo di residenza registrato</p>}
```

con:

```tsx
                            {anpr.success && anpr.found && anpr.residenza?.[0]?.indirizzo && (() => {
                              const resComune = anpr.residenza[0].indirizzo?.comune;
                              const resProv = resComune?.siglaProvinciaIstat ?? (resComune as any)?.siglaProvincia ?? (resComune as any)?.provincia;
                              return (
                                <div className="small">
                                  <div className="fw-bold text-dark mb-1">
                                    {anpr.residenza[0].indirizzo?.toponimo?.specie} {anpr.residenza[0].indirizzo?.toponimo?.denominazioneToponimo}
                                    {anpr.residenza[0].indirizzo?.numeroCivico?.numero ? `, ${anpr.residenza[0].indirizzo.numeroCivico.numero}${anpr.residenza[0].indirizzo.numeroCivico.lettera ?? ''}` : ''}
                                  </div>
                                  <div className="text-muted">
                                    {anpr.residenza[0].indirizzo?.cap} {resComune?.nomeComune} {resProv ? `(${resProv})` : ''}
                                  </div>
                                </div>
                              );
                            })()}
                            {anpr.success && anpr.found && !anpr.residenza?.[0]?.indirizzo && anpr.residenza?.[0]?.localitaEstera && (() => {
                              const estero = anpr.residenza[0].localitaEstera!;
                              const ind = estero.indirizzoEstero;
                              const via = [ind?.toponimo?.denominazione, ind?.toponimo?.numeroCivico].filter(Boolean).join(', ');
                              const localita = [ind?.cap, ind?.localita?.descrizioneLocalita, ind?.localita?.descrizioneStato ? `(${ind.localita.descrizioneStato})` : ''].filter(Boolean).join(' ');
                              return (
                                <div className="small">
                                  <div className="fw-bold text-dark mb-1">Residente estero (AIRE)</div>
                                  {via && <div className="text-muted">{via}</div>}
                                  {localita && <div className="text-muted">{localita}</div>}
                                  {estero.consolato?.descrizioneConsolato && (
                                    <div className="text-muted">Consolato: {estero.consolato.descrizioneConsolato}</div>
                                  )}
                                </div>
                              );
                            })()}
                            {anpr.success && anpr.found && !anpr.residenza?.[0]?.indirizzo && !anpr.residenza?.[0]?.localitaEstera && <p className="small text-muted mb-0">Nessun indirizzo di residenza registrato</p>}
```

- [ ] **Step 3: Type-check frontend-admin**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore.

- [ ] **Step 4: Verifica manuale in browser**

Login admin (dev: `admin`/`admin` con `LDAP_HOST=mock`), menu "Cerca Domicilio", cercare un CF AIRE reale (non riportato per tutela dei dati personali; verificato in debug: residenza Svizzera/Lugano/Ligornetto). Verificare che la card "Indirizzo Fisico (ANPR)" mostri "Residente estero (AIRE)" con via/CAP/città/stato svizzeri e il consolato di Lugano, non campi vuoti. Verificare anche un CF con residenza domestica nota che la card IT esistente resti invariata (nessuna regressione sul ramo esistente).

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
fix(frontend-admin): pannello Verifica Anagrafica mostra indirizzo estero AIRE

Card "Indirizzo Fisico (ANPR)" appariva vuota per soggetti AIRE: il
rendering assumeva sempre residenza[0].indirizzo, ma ANPR C002 per
AIRE restituisce residenza[0].localitaEstera. Verificato dal vivo con
CF reale (AIRE, residenza Svizzera).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
