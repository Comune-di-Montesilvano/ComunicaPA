# Supporto indirizzo estero (POSTAL + SEND) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aggiungere supporto indirizzo estero per POSTAL (GlobalCom) e SEND (PN), propagare il dato da arricchimento tracciati e verifica anagrafica ANPR (AIRE), correggere il bug di estrazione PDF indirizzo estero e il bug di lunghezza denominazione destinatario (eredi).

**Architecture:** Nuovo elenco `COUNTRIES` in `@comunicapa/shared-types`, consumato sia da backend (`payment-config.util.ts`, validazione) sia da frontend-admin (wizard). `physicalAddressConfig` guadagna `countryColumn`; `ResolvedPhysicalAddress` guadagna `foreignState`. POSTAL scopre la capability "Estero" per contratto al Test provider (dato già presente nella risposta SOAP esistente, oggi scartato). Nuova utility `splitDenominazione()` condivisa da POSTAL/SEND per gestire nomi lunghi. Fix mirato dell'algoritmo di parsing indirizzo estero in `pdf_extractor.py` (Python, servizio separato).

**Tech Stack:** NestJS/TypeScript (backend), React/TypeScript (frontend-admin), Python/pdfplumber (pdf-extractor), Jest (test TS), pytest (test Python).

## Global Constraints

- Tutte le modifiche vanno testate in Docker — nessun tool locale (vedi CLAUDE.md, sezione Dev Environment).
- Jest backend sempre con `--maxWorkers=2` (RAM limitata su WSL2).
- Type-check frontend con `tsc -p tsconfig.app.json --noEmit` (mai `tsc -b`).
- Nessuna migration DB necessaria: tutti i campi nuovi (`estero` su `contratti` jsonb, `countryColumn`/`foreignState` dentro `channelConfig` jsonb) vivono in colonne già `jsonb`/schemaless.
- Nessun dato personale reale (nomi/indirizzi reali) nei fixture di test committati — solo dati sintetici che riproducono lo stesso formato/pattern.
- Ogni nuovo campo `wiz*` legato a `channelConfig` va sincronizzato in TUTTI e 3 i punti (gotcha noto, vedi CLAUDE.md "Wizard campagne"): `buildWizChannelConfigDraft`/bozza, `handleWizLaunch`, `resetWizard`/`prefillWizardFrom`.

---

## Task 1: `COUNTRIES` + matching in `@comunicapa/shared-types`

**Files:**
- Create: `packages/shared-types/src/countries.ts`
- Modify: `packages/shared-types/src/index.ts`
- Test: `packages/shared-types/src/countries.spec.ts`

**Interfaces:**
- Produces: `COUNTRIES: readonly string[]` (elenco denominazioni paese in italiano, "Italia" incluso), `matchCountry(raw: string): string | null` (case/accento-insensitive; ritorna la denominazione canonica o `null` se nessun match).

- [ ] **Step 1: Verifica setup test del pacchetto**

Il pacchetto `shared-types` oggi non ha test. Controlla `packages/shared-types/package.json`:

```bash
cat packages/shared-types/package.json
```

Se manca uno script `test`/dipendenza jest, aggiungi (stesso pattern minimale del backend, `ts-jest` non necessario se il pacchetto è già compilato via `tsc` — usa lo stesso runner Jest del backend puntando alla cartella):

```json
{
  "scripts": {
    "test": "jest"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "ts-jest": "^29.1.0",
    "@types/jest": "^29.5.0"
  }
}
```

Crea `packages/shared-types/jest.config.js`:

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
};
```

- [ ] **Step 2: Scrivi il test che fallisce**

Crea `packages/shared-types/src/countries.spec.ts`:

```typescript
import { COUNTRIES, matchCountry } from './countries';

describe('COUNTRIES', () => {
  it('include Italia e una selezione di paesi esteri comuni', () => {
    expect(COUNTRIES).toContain('Italia');
    expect(COUNTRIES).toContain('Svizzera');
    expect(COUNTRIES).toContain('Belgio');
    expect(COUNTRIES).toContain('Germania');
    expect(COUNTRIES).toContain('Canada');
  });

  it('non ha duplicati', () => {
    expect(new Set(COUNTRIES).size).toBe(COUNTRIES.length);
  });
});

describe('matchCountry', () => {
  it('trova un match esatto', () => {
    expect(matchCountry('Svizzera')).toBe('Svizzera');
  });

  it('è case-insensitive', () => {
    expect(matchCountry('svizzera')).toBe('Svizzera');
    expect(matchCountry('SVIZZERA')).toBe('Svizzera');
  });

  it('è accento-insensitive', () => {
    expect(matchCountry('Peru')).toBe('Perù');
    expect(matchCountry('Citta del Vaticano')).toBe('Città del Vaticano');
  });

  it('ignora spazi superflui', () => {
    expect(matchCountry('  Belgio  ')).toBe('Belgio');
  });

  it('ritorna null per stringa vuota', () => {
    expect(matchCountry('')).toBeNull();
    expect(matchCountry('   ')).toBeNull();
  });

  it('ritorna null se nessun match', () => {
    expect(matchCountry('Paese Inesistente XYZ')).toBeNull();
  });
});
```

- [ ] **Step 3: Esegui il test e verifica che fallisca**

```bash
cd packages/shared-types && npx jest countries.spec.ts
```

Expected: FAIL — `Cannot find module './countries'`.

- [ ] **Step 4: Implementa `countries.ts`**

Crea `packages/shared-types/src/countries.ts`:

```typescript
/**
 * Elenco paesi (denominazione italiana) per la gestione indirizzo estero
 * POSTAL/SEND. "Italia" è il valore di default/domestico — se il paese
 * risolto per un destinatario è "Italia" (o assente), nessun campo estero
 * viene inviato ai provider (vedi payment-config.util.ts / postal.strategy.ts).
 */
export const COUNTRIES: readonly string[] = [
  'Italia',
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Antigua e Barbuda',
  'Arabia Saudita', 'Argentina', 'Armenia', 'Australia', 'Austria', 'Azerbaigian',
  'Bahamas', 'Bahrein', 'Bangladesh', 'Barbados', 'Belgio', 'Belize', 'Benin',
  'Bhutan', 'Bielorussia', 'Birmania', 'Bolivia', 'Bosnia ed Erzegovina',
  'Botswana', 'Brasile', 'Brunei', 'Bulgaria', 'Burkina Faso', 'Burundi',
  'Cambogia', 'Camerun', 'Canada', 'Capo Verde', 'Ciad', 'Cile', 'Cina',
  'Cipro', 'Città del Vaticano', 'Colombia', 'Comore', 'Corea del Nord',
  'Corea del Sud', "Costa d'Avorio", 'Costa Rica', 'Croazia', 'Cuba',
  'Danimarca', 'Dominica', 'Ecuador', 'Egitto', 'El Salvador',
  'Emirati Arabi Uniti', 'Eritrea', 'Estonia', 'Eswatini', 'Etiopia', 'Figi',
  'Filippine', 'Finlandia', 'Francia', 'Gabon', 'Gambia', 'Georgia',
  'Germania', 'Ghana', 'Giamaica', 'Giappone', 'Gibuti', 'Giordania',
  'Grecia', 'Grenada', 'Guatemala', 'Guinea', 'Guinea-Bissau',
  'Guinea Equatoriale', 'Guyana', 'Haiti', 'Honduras', 'India', 'Indonesia',
  'Iran', 'Iraq', 'Irlanda', 'Islanda', 'Isole Marshall', 'Isole Salomone',
  'Israele', 'Kazakistan', 'Kenya', 'Kirghizistan', 'Kiribati', 'Kosovo',
  'Kuwait', 'Laos', 'Lesotho', 'Lettonia', 'Libano', 'Liberia', 'Libia',
  'Liechtenstein', 'Lituania', 'Lussemburgo', 'Macedonia del Nord',
  'Madagascar', 'Malawi', 'Malaysia', 'Maldive', 'Mali', 'Malta', 'Marocco',
  'Mauritania', 'Mauritius', 'Messico', 'Micronesia', 'Moldavia', 'Monaco',
  'Mongolia', 'Montenegro', 'Mozambico', 'Namibia', 'Nauru', 'Nepal',
  'Nicaragua', 'Niger', 'Nigeria', 'Norvegia', 'Nuova Zelanda', 'Oman',
  'Paesi Bassi', 'Pakistan', 'Palau', 'Panama', 'Papua Nuova Guinea',
  'Paraguay', 'Perù', 'Polonia', 'Portogallo', 'Qatar', 'Regno Unito',
  'Repubblica Ceca', 'Repubblica Centrafricana', 'Repubblica del Congo',
  'Repubblica Democratica del Congo', 'Repubblica Dominicana', 'Romania',
  'Ruanda', 'Russia', 'Saint Kitts e Nevis', 'Saint Vincent e Grenadine',
  'Samoa', 'San Marino', "Sant'Elena", 'Santa Lucia',
  'São Tomé e Príncipe', 'Senegal', 'Serbia', 'Seychelles', 'Sierra Leone',
  'Singapore', 'Siria', 'Slovacchia', 'Slovenia', 'Somalia', 'Spagna',
  'Sri Lanka', 'Stati Uniti d\'America', 'Sudafrica', 'Sudan',
  'Sudan del Sud', 'Suriname', 'Svezia', 'Svizzera', 'Tagikistan', 'Taiwan',
  'Tanzania', 'Thailandia', 'Timor Est', 'Togo', 'Tonga',
  'Trinidad e Tobago', 'Tunisia', 'Turchia', 'Turkmenistan', 'Tuvalu',
  'Ucraina', 'Uganda', 'Ungheria', 'Uruguay', 'Uzbekistan', 'Vanuatu',
  'Venezuela', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe',
] as const;

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // rimuove diacritici (é->e, ù->u, ...)
}

const NORMALIZED_INDEX: Map<string, string> = new Map(
  COUNTRIES.map((c) => [normalize(c), c]),
);

/**
 * Cerca `raw` in COUNTRIES ignorando maiuscole/minuscole, accenti e spazi
 * superflui. Ritorna la denominazione canonica o null se nessun match —
 * usato sia per il matching bulk (wizard/backend) sia per la
 * precompilazione da ANPR (Sezione 4 dello spec).
 */
export function matchCountry(raw: string): string | null {
  const key = normalize(raw);
  if (!key) return null;
  return NORMALIZED_INDEX.get(key) ?? null;
}
```

- [ ] **Step 5: Esporta dal barrel file**

Modifica `packages/shared-types/src/index.ts`, aggiungi in fondo:

```typescript
export { COUNTRIES, matchCountry } from './countries';
```

- [ ] **Step 6: Esegui il test e verifica che passi**

```bash
cd packages/shared-types && npx jest countries.spec.ts
```

Expected: PASS (tutti i test verdi).

- [ ] **Step 7: Commit**

```bash
git add packages/shared-types/
git commit -m "$(cat <<'EOF'
feat(shared-types): aggiunge COUNTRIES e matchCountry per indirizzo estero

Elenco paesi (denominazione italiana) e matching case/accento-insensitive,
base per il supporto indirizzo estero POSTAL/SEND.
EOF
)"
```

---

## Task 2: `payment-config.util.ts` — `countryColumn`/`foreignState`

**Files:**
- Modify: `apps/backend/src/channels/payment-config.util.ts`
- Test: `apps/backend/src/channels/payment-config.util.spec.ts`

**Interfaces:**
- Consumes: `matchCountry` da `@comunicapa/shared-types` (Task 1).
- Produces: `ResolvedPhysicalAddress.foreignState?: string`, `resolvePhysicalAddress()` legge `physicalAddressConfig.countryColumn`.

- [ ] **Step 1: Scrivi i test che falliscono**

Aggiungi in fondo al blocco `describe('resolvePhysicalAddress', ...)` in `apps/backend/src/channels/payment-config.util.spec.ts` (prima della chiusura `});` finale del file):

```typescript
  it('valorizza foreignState se countryColumn risolve a un paese noto diverso da Italia', () => {
    const recipient = makeRecipient({
      indirizzo: 'Rue Dodonee 132',
      comune: 'Uccle',
      cap: '1180',
      paese: 'belgio',
    });
    const result = resolvePhysicalAddress(recipient, {
      enabled: true,
      addressColumn: 'indirizzo',
      municipalityColumn: 'comune',
      zipColumn: 'cap',
      countryColumn: 'paese',
    });
    expect(result).toEqual({
      address: 'Rue Dodonee 132',
      municipality: 'Uccle',
      zip: '1180',
      foreignState: 'Belgio',
    });
  });

  it('non valorizza foreignState se countryColumn risolve a Italia', () => {
    const recipient = makeRecipient({
      indirizzo: 'Via Roma 1', comune: 'Roma', paese: 'Italia',
    });
    const result = resolvePhysicalAddress(recipient, {
      enabled: true,
      addressColumn: 'indirizzo',
      municipalityColumn: 'comune',
      countryColumn: 'paese',
    });
    expect(result).toEqual({ address: 'Via Roma 1', municipality: 'Roma' });
  });

  it('non valorizza foreignState se countryColumn non è mappata (comportamento invariato)', () => {
    const recipient = makeRecipient({ indirizzo: 'Via Roma 1', comune: 'Roma' });
    const result = resolvePhysicalAddress(recipient, {
      enabled: true,
      addressColumn: 'indirizzo',
      municipalityColumn: 'comune',
    });
    expect(result).toEqual({ address: 'Via Roma 1', municipality: 'Roma' });
  });

  it('non valorizza foreignState se il valore non matcha nessun paese noto', () => {
    const recipient = makeRecipient({
      indirizzo: 'Via Roma 1', comune: 'Roma', paese: 'Paese Inesistente XYZ',
    });
    const result = resolvePhysicalAddress(recipient, {
      enabled: true,
      addressColumn: 'indirizzo',
      municipalityColumn: 'comune',
      countryColumn: 'paese',
    });
    expect(result).toEqual({ address: 'Via Roma 1', municipality: 'Roma' });
  });
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest payment-config.util --maxWorkers=2
```

Expected: FAIL — `foreignState` non presente nel risultato (i nuovi `toEqual` non combaciano, `countryColumn` ignorata).

- [ ] **Step 3: Implementa**

In `apps/backend/src/channels/payment-config.util.ts`:

Aggiungi l'import in cima al file:

```typescript
import { matchCountry } from '@comunicapa/shared-types';
```

Modifica l'interfaccia (riga 10-15):

```typescript
export interface ResolvedPhysicalAddress {
  address: string;
  municipality: string;
  zip?: string;
  province?: string;
  /** Denominazione paese estero (PN: NotificationPhysicalAddress.foreignState). Assente = indirizzo domestico. */
  foreignState?: string;
}
```

Modifica `resolvePhysicalAddress` (righe 112-131):

```typescript
export function resolvePhysicalAddress(
  recipient: Recipient,
  physicalAddressConfig: Record<string, any> | undefined,
): ResolvedPhysicalAddress | null {
  if (!physicalAddressConfig || !physicalAddressConfig.enabled) return null;

  const address = getColumnValue(recipient, physicalAddressConfig.addressColumn).trim();
  const municipality = getColumnValue(recipient, physicalAddressConfig.municipalityColumn).trim();
  if (!address || !municipality) return null;

  const zip = getColumnValue(recipient, physicalAddressConfig.zipColumn).trim();
  const province = getColumnValue(recipient, physicalAddressConfig.provinceColumn).trim();

  const rawCountry = getColumnValue(recipient, physicalAddressConfig.countryColumn).trim();
  const foreignState = rawCountry ? matchCountry(rawCountry) : null;
  // "Italia" è il valore domestico di default: non viene mai inviato come
  // foreignState, anche se matcha esplicitamente in COUNTRIES.
  const isForeign = !!foreignState && foreignState !== 'Italia';

  return {
    address,
    municipality,
    ...(zip ? { zip } : {}),
    ...(province ? { province } : {}),
    ...(isForeign ? { foreignState } : {}),
  };
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest payment-config.util --maxWorkers=2
```

Expected: PASS — tutti i test (esistenti + nuovi) verdi.

- [ ] **Step 5: Type-check**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Expected: nessun errore.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/channels/payment-config.util.ts apps/backend/src/channels/payment-config.util.spec.ts
git commit -m "$(cat <<'EOF'
feat(backend): resolvePhysicalAddress risolve foreignState da countryColumn

SEND riceve già foreignState via spread di ResolvedPhysicalAddress
(NotificationPhysicalAddress.foreignState, verificato su spec PN raw) —
nessuna modifica a send-dispatch.service.ts necessaria.
EOF
)"
```

---

## Task 3: POSTAL — scoperta e persistenza capability "Estero" per contratto

**Files:**
- Modify: `apps/backend/src/channels/postal/globalcom-client.service.ts`
- Modify: `apps/backend/src/entities/postal-provider-config.entity.ts`
- Modify: `apps/backend/src/postal-providers/dto/postal-provider.dto.ts`
- Test: `apps/backend/src/channels/postal/globalcom-client.service.spec.ts`

**Interfaces:**
- Produces: `GbcContratto.estero: boolean`, `PostalProviderConfig.contratti[].estero: boolean`, `PostalProviderContrattoDto.estero: boolean`.

- [ ] **Step 1: Leggi il test esistente per il pattern di `informazioniUtenza`**

```bash
grep -n "informazioniUtenza\|ContrattiH2H" apps/backend/src/channels/postal/globalcom-client.service.spec.ts
```

Individua il test che verifica il parsing di `ContrattiH2H` (mock della risposta SOAP) — sarà il punto da estendere.

- [ ] **Step 2: Scrivi il test che fallisce**

Nel `describe('informazioniUtenza', ...)` esistente in `globalcom-client.service.spec.ts`, aggiungi:

```typescript
  it('legge il flag Estero per ogni contratto (oggi scartato)', async () => {
    mockClient.InformazioniUtenzaAsync.mockResolvedValue([{
      InformazioniUtenzaResult: {
        OperazioneRiuscita: true,
        ProdottiDisponibili: { ServiceType: ['Raccomandata'] },
        ContrattiH2H: {
          DatiContrattoCOLMOLExt: [
            { CodiceContratto: 'C1', Descrizione: 'Contratto Market', Tipologia: 'RaccomandataMarket', Estero: true },
            { CodiceContratto: 'C2', Descrizione: 'Contratto Contest', Tipologia: 'LetteraContest', Estero: false },
          ],
        },
      },
    }]);

    const result = await client.informazioniUtenza(baseCreds);

    expect(result.contratti).toEqual([
      { codiceContratto: 'C1', descrizione: 'Contratto Market', tipologia: 'RaccomandataMarket', estero: true },
      { codiceContratto: 'C2', descrizione: 'Contratto Contest', tipologia: 'LetteraContest', estero: false },
    ]);
  });

  it('tratta Estero mancante/undefined come false (contratti legacy pre-fix)', async () => {
    mockClient.InformazioniUtenzaAsync.mockResolvedValue([{
      InformazioniUtenzaResult: {
        OperazioneRiuscita: true,
        ProdottiDisponibili: { ServiceType: ['Raccomandata'] },
        ContrattiH2H: {
          DatiContrattoCOLMOLExt: { CodiceContratto: 'C1', Descrizione: 'D', Tipologia: 'RaccomandataMarket' },
        },
      },
    }]);

    const result = await client.informazioniUtenza(baseCreds);

    expect(result.contratti).toEqual([
      { codiceContratto: 'C1', descrizione: 'D', tipologia: 'RaccomandataMarket', estero: false },
    ]);
  });
```

(Adatta i nomi `mockClient`/`baseCreds` a quelli reali già usati nel file — leggi le prime 40 righe di `globalcom-client.service.spec.ts` per il setup esatto del mock `soap.createClientAsync` prima di scrivere lo step.)

- [ ] **Step 3: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest globalcom-client.service --maxWorkers=2
```

Expected: FAIL — `result.contratti` non contiene la chiave `estero`.

- [ ] **Step 4: Implementa**

In `apps/backend/src/channels/postal/globalcom-client.service.ts`:

Modifica `GbcContratto` (righe 101-105):

```typescript
export interface GbcContratto {
  codiceContratto: string;
  descrizione: string;
  tipologia: string;
  /** DatiContrattoCOLMOLExt.Estero — true se il contratto supporta spedizioni estero (WSDL riga 221). */
  estero: boolean;
}
```

Modifica il parsing in `informazioniUtenza` (righe 348-363):

```typescript
    const contrattiWrapper = info['ContrattiH2H'] as {
      DatiContrattoCOLMOLExt?:
        | { CodiceContratto?: string; Descrizione?: string; Tipologia?: string; Estero?: boolean }
        | Array<{ CodiceContratto?: string; Descrizione?: string; Tipologia?: string; Estero?: boolean }>;
    } | undefined;
    const contrattiRaw = contrattiWrapper?.DatiContrattoCOLMOLExt;
    const contrattiList = Array.isArray(contrattiRaw) ? contrattiRaw : contrattiRaw ? [contrattiRaw] : [];
    return {
      operazioneRiuscita: true,
      centroDiCosto: (info['CentroDiCosto'] as string) || undefined,
      prodottiDisponibili: prodottiDisponibili as string[],
      contratti: contrattiList.map((c) => ({
        codiceContratto: c.CodiceContratto || '',
        descrizione: c.Descrizione || '',
        tipologia: c.Tipologia || '',
        estero: Boolean(c.Estero),
      })),
    };
```

- [ ] **Step 5: Esegui i test e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest globalcom-client.service --maxWorkers=2
```

Expected: PASS.

- [ ] **Step 6: Propaga il tipo a entity e DTO**

In `apps/backend/src/entities/postal-provider-config.entity.ts`, modifica il campo `contratti` (riga 73-74):

```typescript
  @Column({ type: 'jsonb', default: [] })
  contratti!: Array<{ codiceContratto: string; descrizione: string; tipologia: string; estero: boolean }>;
```

In `apps/backend/src/postal-providers/dto/postal-provider.dto.ts`, modifica `PostalProviderContrattoDto` (righe 99-103):

```typescript
export interface PostalProviderContrattoDto {
  codiceContratto: string;
  descrizione: string;
  tipologia: string;
  estero: boolean;
}
```

Nessun'altra modifica necessaria: `postal-providers.service.ts` assegna `entity.contratti = info.contratti` per copia diretta (riga 190) — il nuovo campo fluisce automaticamente da `GbcInfoUtenza.contratti` fino alla response DTO (`contratti: entity.contratti`, righe 66 e 220).

- [ ] **Step 7: Type-check backend**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
```

Expected: nessun errore (nessuna migration necessaria, colonna già `jsonb`).

- [ ] **Step 8: Esegui la suite completa backend**

```bash
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

Expected: stesso failure set noto (1 fallimento pre-esistente `app.controller.spec.ts` `isLdapMock`), nessuna nuova regressione.

- [ ] **Step 9: Commit**

```bash
git add apps/backend/src/channels/postal/globalcom-client.service.ts apps/backend/src/channels/postal/globalcom-client.service.spec.ts apps/backend/src/entities/postal-provider-config.entity.ts apps/backend/src/postal-providers/dto/postal-provider.dto.ts
git commit -m "$(cat <<'EOF'
feat(postal): scopre e persiste il flag Estero per ogni CodiceContratto

DatiContrattoCOLMOLExt.Estero era già nella risposta InformazioniUtenza
(stessa chiamata del tasto Test) ma veniva scartato — nessuna nuova
chiamata SOAP, solo parsing esteso. Base per il gate estero in wizard
(task successivo).
EOF
)"
```

---

## Task 4: POSTAL — invio con `Stato` (indirizzo estero) + `splitDenominazione`

**Files:**
- Create: `apps/backend/src/channels/postal/denominazione.util.ts`
- Modify: `apps/backend/src/channels/postal/globalcom-client.service.ts`
- Modify: `apps/backend/src/channels/postal/postal.strategy.ts`
- Modify: `apps/backend/src/settings/settings.registry.ts`
- Test: `apps/backend/src/channels/postal/denominazione.util.spec.ts`
- Test: `apps/backend/src/channels/postal/postal.strategy.spec.ts`

**Interfaces:**
- Consumes: `AppSettingsService.get('notifiche.denominazioneAbbreviations')` (nuova chiave, Step 6).
- Produces: `splitDenominazione(fullName: string, abbreviations: Array<{pattern: string; replacement: string}>, maxPerLine?: number): { denominazione1: string; denominazione2?: string }`.

### Parte A — `splitDenominazione`

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `apps/backend/src/channels/postal/denominazione.util.spec.ts`:

```typescript
import { splitDenominazione } from './denominazione.util';

describe('splitDenominazione', () => {
  it('nome corto: denominazione1 piena, denominazione2 assente', () => {
    const result = splitDenominazione('Mario Rossi', []);
    expect(result).toEqual({ denominazione1: 'Mario Rossi' });
  });

  it('nome che eccede 44 char va a capo su denominazione2 (word-wrap)', () => {
    const nome = 'Nome Cognome Molto Lungo Che Supera I Quarantaquattro Caratteri';
    const result = splitDenominazione(nome, []);
    expect(result.denominazione1.length).toBeLessThanOrEqual(44);
    expect(result.denominazione2!.length).toBeLessThanOrEqual(44);
    // Nessuna parola spezzata a metà: ricostruendo D1+" "+D2 si riottiene il testo originale
    expect(`${result.denominazione1} ${result.denominazione2}`.trim()).toBe(nome);
  });

  it('applica la tabella di abbreviazioni prima dello split', () => {
    const nome = 'IMPERSONALMENTE E COLLETTIVAMENTE AGLI EREDI DI ERASMO ALESSANDRO';
    const result = splitDenominazione(nome, [
      { pattern: 'IMPERSONALMENTE E COLLETTIVAMENTE AGLI EREDI DI', replacement: 'EREDI DI' },
    ]);
    expect(result.denominazione1).toBe('EREDI DI ERASMO ALESSANDRO');
    expect(result.denominazione1.length).toBeLessThanOrEqual(44);
    expect(result.denominazione2).toBeUndefined();
  });

  it('tronca secco denominazione2 se il risultato eccede 88 char totali anche dopo abbreviazione', () => {
    const nomeLunghissimo = 'A'.repeat(50) + ' ' + 'B'.repeat(50);
    const result = splitDenominazione(nomeLunghissimo, []);
    expect(result.denominazione1.length).toBeLessThanOrEqual(44);
    expect(result.denominazione2!.length).toBeLessThanOrEqual(44);
  });

  it('non applica abbreviazioni che non matchano', () => {
    const result = splitDenominazione('Mario Rossi', [
      { pattern: 'Pattern Inesistente', replacement: 'X' },
    ]);
    expect(result).toEqual({ denominazione1: 'Mario Rossi' });
  });

  it('rispetta un maxPerLine custom', () => {
    const result = splitDenominazione('Mario Rossi Verdi', [], 10);
    expect(result.denominazione1.length).toBeLessThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

```bash
docker compose exec backend node_modules/.bin/jest denominazione.util --maxWorkers=2
```

Expected: FAIL — `Cannot find module './denominazione.util'`.

- [ ] **Step 3: Implementa**

Crea `apps/backend/src/channels/postal/denominazione.util.ts`:

```typescript
export interface DenominazioneAbbreviation {
  pattern: string;
  replacement: string;
}

/**
 * Applica una tabella di abbreviazioni (es. dicitura legale eredi troppo
 * lunga) e poi spezza il risultato su due righe ≤maxPerLine caratteri
 * ciascuna (WSDL GlobalCom InfoIndirizzoExt.Denominazione1/2, entrambe max
 * 44 char — vedi manuale tecnico §3.3.1). Word-wrap sull'ultimo spazio
 * utile: mai una parola spezzata a metà. Se anche dopo l'abbreviazione il
 * risultato eccede maxPerLine*2 caratteri totali, denominazione2 viene
 * troncata secca come ultima rete di sicurezza.
 */
export function splitDenominazione(
  fullName: string,
  abbreviations: DenominazioneAbbreviation[],
  maxPerLine = 44,
): { denominazione1: string; denominazione2?: string } {
  let text = fullName.trim();
  for (const { pattern, replacement } of abbreviations) {
    text = text.split(pattern).join(replacement);
  }
  text = text.trim();

  if (text.length <= maxPerLine) {
    return { denominazione1: text };
  }

  // Word-wrap: trova l'ultimo spazio entro maxPerLine per non spezzare una parola.
  let splitAt = text.lastIndexOf(' ', maxPerLine);
  if (splitAt <= 0) splitAt = maxPerLine; // parola singola più lunga del limite: taglio secco

  const denominazione1 = text.slice(0, splitAt).trim();
  const denominazione2 = text.slice(splitAt).trim().slice(0, maxPerLine);

  return { denominazione1, denominazione2: denominazione2 || undefined };
}
```

- [ ] **Step 4: Esegui il test e verifica che passi**

```bash
docker compose exec backend node_modules/.bin/jest denominazione.util --maxWorkers=2
```

Expected: PASS.

### Parte B — integrazione in `postal.strategy.ts` (Stato + denominazione)

- [ ] **Step 5: Scrivi il test che fallisce**

In `apps/backend/src/channels/postal/postal.strategy.spec.ts`, aggiungi (usa `baseRecipient`/`baseCampaign`/`baseProvider` già definiti nel file, vedi Step 1):

```typescript
  it('invia Stato quando physicalAddressConfig risolve un indirizzo estero', async () => {
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO123', stato: 'Accettato' } as any);
    providers.getActive.mockResolvedValue(baseProvider());

    const recipientEstero = {
      ...baseRecipient,
      extraData: { indirizzo: 'Rue Dodonee 132', comune: 'Uccle', cap: '1180', paese: 'Belgio' },
    };
    const campaignEstero = baseCampaign({
      physicalAddressConfig: {
        enabled: true,
        addressColumn: 'indirizzo',
        municipalityColumn: 'comune',
        zipColumn: 'cap',
        countryColumn: 'paese',
      },
    });

    await strategy.send(recipientEstero as never, campaignEstero as never, undefined, 'attempt-uuid-2', 0);

    const invioArg = globalCom.invioExtSingolo.mock.calls[0][1];
    expect(invioArg.destinatario.stato).toBe('Belgio');
  });

  it('non invia Stato per indirizzo domestico', async () => {
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO123', stato: 'Accettato' } as any);
    providers.getActive.mockResolvedValue(baseProvider());

    await strategy.send(baseRecipient as never, baseCampaign() as never, undefined, 'attempt-uuid-3', 0);

    const invioArg = globalCom.invioExtSingolo.mock.calls[0][1];
    expect(invioArg.destinatario.stato).toBeUndefined();
  });

  it('spezza denominazione1/2 per un nome lungo (dicitura eredi)', async () => {
    globalCom.invioExtSingolo.mockResolvedValue({ idPro: 'IDPRO123', stato: 'Accettato' } as any);
    providers.getActive.mockResolvedValue(baseProvider());

    const recipientErede = {
      ...baseRecipient,
      fullName: 'IMPERSONALMENTE E COLLETTIVAMENTE AGLI EREDI DI ERASMO ALESSANDRO',
    };

    await strategy.send(recipientErede as never, baseCampaign() as never, undefined, 'attempt-uuid-4', 0);

    const invioArg = globalCom.invioExtSingolo.mock.calls[0][1];
    expect(invioArg.destinatario.denominazione1.length).toBeLessThanOrEqual(44);
    if (invioArg.destinatario.denominazione2) {
      expect(invioArg.destinatario.denominazione2.length).toBeLessThanOrEqual(44);
    }
  });
```

Nota: questi test richiedono che `PostalStrategy` riceva `AppSettingsService` nel costruttore (Step 6) — aggiorna anche il `beforeEach`/`Test.createTestingModule` del file con un mock:

```typescript
    const mockSettings = { get: jest.fn(async () => '[]') };
```

e passalo come provider `{ provide: AppSettingsService, useValue: mockSettings }`.

- [ ] **Step 6: Esegui i test e verifica che falliscano**

```bash
docker compose exec backend node_modules/.bin/jest postal.strategy --maxWorkers=2
```

Expected: FAIL — `invioArg.destinatario.stato` undefined nel primo test, costruttore con dependency mancante o `denominazione1` non troncata.

- [ ] **Step 7: Registra la chiave settings**

In `apps/backend/src/settings/settings.registry.ts`, aggiungi dentro `SETTING_DEFS` (vicino alle altre chiavi non-postal, es. dopo `retention.maxDays`):

```typescript
  // Tabella abbreviazioni denominazione destinatario (JSON array
  // [{pattern, replacement}]), usata sia da POSTAL (Denominazione1/2 max 44
  // char ciascuna) sia da SEND (denomination max 88 char) quando il nome
  // completo eccede il limite — es. dicitura legale eredi. Cross-canale,
  // per questo in app_settings e non in postal_provider_configs (che è
  // audit/config per-provider, non wording generico).
  'notifiche.denominazioneAbbreviations': {
    type: 'string',
    default: JSON.stringify([
      { pattern: 'IMPERSONALMENTE E COLLETTIVAMENTE AGLI EREDI DI', replacement: 'EREDI DI' },
    ]),
  },
```

- [ ] **Step 8: Integra in `postal.strategy.ts`**

Modifica `apps/backend/src/channels/postal/postal.strategy.ts`:

Aggiungi import in cima:

```typescript
import { AppSettingsService } from '../../settings/app-settings.service';
import { splitDenominazione, type DenominazioneAbbreviation } from './denominazione.util';
```

(Verifica il path/nome esatto di `AppSettingsService` con `grep -rn "class AppSettingsService" apps/backend/src/settings/` prima di scrivere l'import — usa quello trovato.)

Aggiungi il parametro al costruttore (righe 18-22):

```typescript
  constructor(
    private readonly globalCom: GlobalComClient,
    private readonly providers: PostalProvidersService,
    private readonly attachments: AttachmentService,
    private readonly settings: AppSettingsService,
  ) {}
```

Sostituisci la costruzione di `destinatario` (righe 84-92):

```typescript
    const abbreviationsRaw = await this.settings.get<string>('notifiche.denominazioneAbbreviations');
    let abbreviations: DenominazioneAbbreviation[] = [];
    try {
      abbreviations = JSON.parse(abbreviationsRaw || '[]');
    } catch {
      this.logger.warn(`notifiche.denominazioneAbbreviations non è JSON valido, ignorata: ${abbreviationsRaw}`);
    }
    const { denominazione1, denominazione2 } = splitDenominazione(
      recipient.fullName || recipient.codiceFiscale,
      abbreviations,
    );

    const destinatario: GbcAddress = {
      denominazione1,
      denominazione2,
      indirizzo1: resolvedAddress.address,
      cap: resolvedAddress.zip,
      citta: resolvedAddress.municipality,
      provincia: resolvedAddress.province,
      stato: resolvedAddress.foreignState,
      codiceFiscale: servizio.startsWith('Agol') ? undefined : recipient.codiceFiscale,
      email: recipient.email || undefined,
    };
```

- [ ] **Step 9: Aggiungi `stato` a `GbcAddress` e mappalo su `Stato`**

In `apps/backend/src/channels/postal/globalcom-client.service.ts`, modifica `GbcAddress` (righe 5-27), aggiungi dopo `provincia?: string;`:

```typescript
  /** InfoIndirizzoExt.Stato — denominazione paese estero (WSDL riga 34); assente = domestico (default GlobalCom "ITALIA"). */
  stato?: string;
```

Modifica `toInfoIndirizzoExt` (righe 117-129), aggiungi dopo la riga `Provincia`:

```typescript
    ...(addr.stato ? { Stato: addr.stato } : {}),
```

- [ ] **Step 10: Aggiorna il modulo NestJS se necessario**

```bash
grep -n "AppSettingsService" apps/backend/src/channels/postal/*.module.ts apps/backend/src/channels/channels.module.ts 2>/dev/null
```

Se `AppSettingsService` non è già importato/esportato nel modulo che dichiara `PostalStrategy`, aggiungi l'import del `SettingsModule` (o del provider diretto) in quel modulo — verifica il pattern già usato da un altro service che inietta `AppSettingsService` (es. `grep -rln "AppSettingsService" apps/backend/src/channels/`) e replicalo.

- [ ] **Step 11: Esegui i test e verifica che passino**

```bash
docker compose exec backend node_modules/.bin/jest postal.strategy denominazione.util --maxWorkers=2
```

Expected: PASS.

- [ ] **Step 12: Type-check + suite completa**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

Expected: nessun errore tsc; stesso failure set noto (1 pre-esistente).

- [ ] **Step 13: Commit**

```bash
git add apps/backend/src/channels/postal/denominazione.util.ts apps/backend/src/channels/postal/denominazione.util.spec.ts apps/backend/src/channels/postal/globalcom-client.service.ts apps/backend/src/channels/postal/postal.strategy.ts apps/backend/src/channels/postal/postal.strategy.spec.ts apps/backend/src/settings/settings.registry.ts
git commit -m "$(cat <<'EOF'
feat(postal): invia Stato per indirizzo estero, gestisce denominazioni lunghe

InfoIndirizzoExt.Stato (mai mappato finora) valorizzato quando
resolvePhysicalAddress risolve un paese estero. Nuova splitDenominazione()
(abbreviazione configurabile + word-wrap 2 righe da 44 char) risolve il bug
reale di Denominazione1 troncata/overflow su diciture lunghe (es. dicitura
legale eredi, 47+ char da sola).
EOF
)"
```

---

## Task 5: SEND — denominazione lunga (troncamento a 88 char)

**Files:**
- Modify: `apps/backend/src/channels/send/send-dispatch.service.ts`
- Test: `apps/backend/src/channels/send/send-dispatch.service.spec.ts`

**Interfaces:**
- Consumes: `splitDenominazione` da `../postal/denominazione.util` (Task 4) — riusata solo per l'abbreviazione, non per lo split multi-riga (SEND ha un solo campo).

- [ ] **Step 1: Individua il test esistente per il payload `recipients`**

```bash
grep -n "denomination\|describe(" apps/backend/src/channels/send/send-dispatch.service.spec.ts | head -20
```

- [ ] **Step 2: Scrivi il test che fallisce**

Aggiungi un test nello stesso `describe` che verifica il payload (adatta ai mock/setup già presenti nel file — stesso pattern del test esistente su `denomination`):

```typescript
  it('applica abbreviazioni e tronca denomination a 88 char se troppo lunga', async () => {
    mockSettings.get.mockImplementation(async (key: string) => {
      if (key === 'notifiche.denominazioneAbbreviations') {
        return JSON.stringify([
          { pattern: 'IMPERSONALMENTE E COLLETTIVAMENTE AGLI EREDI DI', replacement: 'EREDI DI' },
        ]);
      }
      return defaultSettingsMock(key); // usa l'helper/mock già esistente nel file per le altre chiavi
    });

    const recipientErede = makeRecipient({ fullName: 'IMPERSONALMENTE E COLLETTIVAMENTE AGLI EREDI DI ERASMO ALESSANDRO' });

    await service.dispatch(/* stessi argomenti del test esistente, con recipientErede */);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.recipients[0].denomination).toBe('EREDI DI ERASMO ALESSANDRO');
    expect(body.recipients[0].denomination.length).toBeLessThanOrEqual(88);
  });
```

Adatta i nomi (`makeRecipient`, `fetchMock`, la firma di `service.dispatch`, l'helper mock settings) a quelli realmente usati nel file — leggi le prime 60 righe di `send-dispatch.service.spec.ts` prima di scrivere questo step per allinearti esattamente al setup esistente.

- [ ] **Step 3: Esegui il test e verifica che fallisca**

```bash
docker compose exec backend node_modules/.bin/jest send-dispatch.service --maxWorkers=2
```

Expected: FAIL — `denomination` è ancora la stringa intera non abbreviata.

- [ ] **Step 4: Implementa**

In `apps/backend/src/channels/send/send-dispatch.service.ts`, aggiungi import:

```typescript
import { splitDenominazione } from '../postal/denominazione.util';
```

Modifica il punto di costruzione del payload (riga 207, dentro il blocco `recipients: [{ ... }]`):

Prima di `const payload`, aggiungi:

```typescript
    const abbreviationsRaw = await this.settings.get<string>('notifiche.denominazioneAbbreviations');
    let abbreviations: Array<{ pattern: string; replacement: string }> = [];
    try {
      abbreviations = JSON.parse(abbreviationsRaw || '[]');
    } catch {
      this.logger.warn(`notifiche.denominazioneAbbreviations non è JSON valido, ignorata: ${abbreviationsRaw}`);
    }
    // SEND ha un solo campo denomination (max 88 char, verificato su spec PN
    // raw) — riusa splitDenominazione solo per l'abbreviazione (maxPerLine=88
    // disabilita di fatto lo split multi-riga per nomi fino a 88 char).
    const { denominazione1: denomination } = splitDenominazione(
      recipient.fullName ?? recipient.codiceFiscale,
      abbreviations,
      88,
    );
```

(Verifica che `this.logger` esista già nella classe — se il service non ha un `Logger` NestJS istanziato, aggiungilo con lo stesso pattern di `postal.strategy.ts`: `private readonly logger = new Logger(SendDispatchService.name);`.)

Modifica la riga `denomination: recipient.fullName ?? recipient.codiceFiscale,` (riga 207) in:

```typescript
        denomination,
```

- [ ] **Step 5: Esegui il test e verifica che passi**

```bash
docker compose exec backend node_modules/.bin/jest send-dispatch.service --maxWorkers=2
```

Expected: PASS.

- [ ] **Step 6: Type-check + suite completa**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

Expected: nessun errore; stesso failure set noto.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/src/channels/send/send-dispatch.service.ts apps/backend/src/channels/send/send-dispatch.service.spec.ts
git commit -m "$(cat <<'EOF'
feat(send): applica abbreviazioni e tronca denomination a 88 char

Stessa tabella di abbreviazioni condivisa con POSTAL (Task 4) — evita
troncamenti secchi che perderebbero il nome reale del destinatario su
diciture lunghe (es. eredi).
EOF
)"
```

---

## Task 6: Fix estrazione indirizzo estero — `pdf_extractor.py`

**Files:**
- Modify: `services/pdf-extractor/app/pdf_extractor.py`
- Modify: `services/pdf-extractor/tests/conftest.py`
- Test: `services/pdf-extractor/tests/test_pdf_extractor.py`

**Interfaces:**
- Consumes: nessuna dipendenza da altri task (Python, indipendente dal backend TS).
- Produces: `PdfExtractor.extract_address()` invariato nella firma, comportamento corretto sul ramo estero.

- [ ] **Step 1: Aggiungi fixture sintetiche per i formati reali problematici**

In `services/pdf-extractor/tests/conftest.py`, aggiungi dopo `pdf_no_address`:

```python
@pytest.fixture
def pdf_foreign_address_clean() -> bytes:
    """Formato pulito: via - CAP comune - stato (CAP 4 cifre, non 5 — Belgio)."""
    return _make_pdf(["Residente in: Rue Test 132 - 1180 Uccle - Belgio\n"])


@pytest.fixture
def pdf_foreign_address_cap_embedded() -> bytes:
    """CAP estero incorporato nella riga indirizzo (keyword 'CAP'), seguito
    da uno pseudocodice a 5 cifre + comune che NON è un CAP reale — bug
    reale riscontrato su un documento Maggioli reale (Svizzera)."""
    return _make_pdf(["Residente in: Bahnhofplatz 2 CAP 8802 - 86078 Testdorf - Svizzera\n"])


@pytest.fixture
def pdf_foreign_address_no_cap() -> bytes:
    """Nessun CAP nella riga (formato osservato su documenti reali svizzeri/tedeschi)."""
    return _make_pdf(["Residente in: Teststrasse 11 - Testort - Svizzera\n"])


@pytest.fixture
def pdf_foreign_address_parenthetical() -> bytes:
    """Nome stato ripetuto tra parentesi subito dopo la via (formato osservato
    su documenti reali svizzeri)."""
    return _make_pdf(["Residente in: Teststrasse 67 (Svizzera) - Testcity - Svizzera\n"])


@pytest.fixture
def pdf_foreign_address_alphanumeric_zip() -> bytes:
    """CAP alfanumerico (formato canadese) — limite noto/accettato: resta
    dentro il comune, non viene separato."""
    return _make_pdf(["Residente in: 732 Test Blvd. Testregion - Testcity R2Y 1M8 - Canada\n"])


@pytest.fixture
def pdf_foreign_address_extra_segment() -> bytes:
    """4 segmenti invece di 3 (duplicazione CAP/stato tra parentesi) —
    formato osservato su un documento reale belga."""
    return _make_pdf(["Residente in: Rue Test 8 - CAP. 5030 (Belgio) - 5030 Testville - Belgio\n"])
```

- [ ] **Step 2: Scrivi i test che falliscono**

In `services/pdf-extractor/tests/test_pdf_extractor.py`, aggiungi dopo `test_extract_address_domestic`:

```python
def test_extract_address_foreign_clean(pdf_foreign_address_clean):
    addr = PdfExtractor(pdf_foreign_address_clean).extract_address()
    assert addr.indirizzo == "Rue Test 132"
    assert addr.cap == "1180"
    assert addr.comune == "Uccle"
    assert addr.provincia == ""
    assert addr.stato_estero == "Belgio"


def test_extract_address_foreign_cap_embedded_in_street(pdf_foreign_address_cap_embedded):
    """Regressione bug reale: il CAP vero (8802) è dentro la via dopo la
    keyword 'CAP', lo pseudocodice a 5 cifre (86078) prima del comune NON va
    scambiato per il CAP."""
    addr = PdfExtractor(pdf_foreign_address_cap_embedded).extract_address()
    assert addr.indirizzo == "Bahnhofplatz 2"
    assert addr.cap == "8802"
    assert addr.comune == "Testdorf"
    assert addr.stato_estero == "Svizzera"


def test_extract_address_foreign_no_cap(pdf_foreign_address_no_cap):
    addr = PdfExtractor(pdf_foreign_address_no_cap).extract_address()
    assert addr.indirizzo == "Teststrasse 11"
    assert addr.cap == ""
    assert addr.comune == "Testort"
    assert addr.stato_estero == "Svizzera"


def test_extract_address_foreign_parenthetical_state(pdf_foreign_address_parenthetical):
    addr = PdfExtractor(pdf_foreign_address_parenthetical).extract_address()
    assert addr.indirizzo == "Teststrasse 67"
    assert addr.comune == "Testcity"
    assert addr.stato_estero == "Svizzera"


def test_extract_address_foreign_alphanumeric_zip_stays_in_comune(pdf_foreign_address_alphanumeric_zip):
    addr = PdfExtractor(pdf_foreign_address_alphanumeric_zip).extract_address()
    assert addr.indirizzo == "732 Test Blvd. Testregion"
    assert addr.cap == ""
    assert addr.comune == "Testcity R2Y 1M8"
    assert addr.stato_estero == "Canada"


def test_extract_address_foreign_extra_segment(pdf_foreign_address_extra_segment):
    addr = PdfExtractor(pdf_foreign_address_extra_segment).extract_address()
    assert addr.cap == "5030"
    assert addr.comune == "Testville"
    assert addr.stato_estero == "Belgio"
```

- [ ] **Step 3: Esegui i test e verifica che falliscano**

```bash
cd services/pdf-extractor && python3 -m pytest tests/test_pdf_extractor.py -k foreign -v
```

Expected: FAIL su `test_extract_address_foreign_cap_embedded_in_street` (cap="86078" invece di "8802", indirizzo con cruft) e possibilmente sugli altri (CAP a 4 cifre/assente non gestiti dalla regex `\d{5}` fissa attuale).

- [ ] **Step 4: Implementa il nuovo algoritmo**

In `services/pdf-extractor/app/pdf_extractor.py`, sostituisci `_RE_FOREIGN` (righe 21-24) e il ramo che la usa in `extract_address` (righe 78-86).

Rimuovi `_RE_FOREIGN` come costante regex e sostituiscila con una singola regex di cattura generica + un metodo di parsing:

```python
    # Regex generica: cattura tutto il contenuto dopo "Residente in:" fino a
    # newline — il parsing del contenuto (domestico vs estero) è delegato
    # rispettivamente a _RE_DOMESTIC (provato per primo) e a
    # _parse_foreign_address (fallback quando _RE_DOMESTIC non matcha).
    _RE_RESIDENTE_IN_LINE = re.compile(
        r"Residente\s+in\s*:\s*(.+?)\s*(?:\n|$)",
        re.MULTILINE | re.IGNORECASE,
    )
```

Sostituisci il metodo `extract_address` (righe 62-101):

```python
    def extract_address(self) -> AddressData:
        with self._open() as pdf:
            if not pdf.pages:
                raise AddressExtractionError("PDF vuoto")
            text = pdf.pages[0].extract_text() or ""

        m = self._RE_DOMESTIC.search(text)
        if m:
            return AddressData(
                indirizzo=m.group(1).strip(),
                cap=m.group(2).strip(),
                comune=m.group(3).strip(),
                provincia=m.group(4).strip(),
                stato_estero="",
            )

        m = self._RE_RESIDENTE_IN_LINE.search(text)
        if m:
            foreign = self._parse_foreign_address(m.group(1))
            if foreign:
                return foreign

        m = self._RE_RESIDENZA_LABEL.search(text)
        if m:
            indirizzo = re.sub(r"\s+", " ", m.group(4)).strip()
            return AddressData(
                indirizzo=indirizzo,
                cap=m.group(1).strip(),
                comune=m.group(2).strip(),
                provincia=m.group(3).strip(),
                stato_estero="",
            )

        raise AddressExtractionError(
            f"Pattern 'Residente in:' non trovato. Testo pagina 0:\n{text[:500]}"
        )

    @staticmethod
    def _parse_foreign_address(line: str) -> Optional["AddressData"]:
        """Parsing indirizzo estero per segmenti (non una singola regex): il
        formato reale varia troppo (CAP 4/5 cifre, CAP alfanumerico, CAP
        assente, CAP incorporato nella via, nome stato ripetuto tra
        parentesi) per una regex unica — verificato su 10 documenti reali
        Maggioli (Belgio/Svizzera/Germania/Canada), vedi design doc
        2026-07-28-indirizzo-estero-design.md Sezione 5.

        1. Split su " - " (normalizzato da en-dash).
        2. Ultimo segmento = stato.
        3. Penultimo segmento = "[CAP] comune": primo token numerico
           3-6 cifre -> CAP guess, resto -> comune; altrimenti CAP vuoto e
           l'intero segmento è comune (limite noto: CAP alfanumerici tipo
           Canada restano dentro il comune).
        4. Segmenti restanti = indirizzo grezzo, ripulito da una keyword
           esplicita "CAP <valore>" (CAP autoritativo, sovrascrive il guess
           del punto 3) e da una parentetica finale tipo "(Svizzera)".
        """
        normalized = line.replace("–", "-").strip()
        parts = [p.strip() for p in normalized.split(" - ") if p.strip()]
        if len(parts) < 3:
            return None

        stato = parts[-1]
        capcomune = parts[-2]
        indirizzo_raw = " - ".join(parts[:-2])

        cap_match = re.search(r"CAP\.?\s*(\w+)", indirizzo_raw, re.IGNORECASE)
        cap_explicit = cap_match.group(1) if cap_match else None
        if cap_explicit:
            indirizzo = re.sub(
                r"\s*-?\s*CAP\.?\s*\w+\s*(\([^)]*\))?", "", indirizzo_raw, flags=re.IGNORECASE
            ).strip()
        else:
            indirizzo = indirizzo_raw
        indirizzo = re.sub(r"\s*\([^)]*\)\s*$", "", indirizzo).strip()

        cm = re.match(r"^(\d{3,6})\s+(.+)$", capcomune)
        if cm:
            cap_guess, comune = cm.group(1), cm.group(2)
        else:
            cap_guess, comune = None, capcomune

        cap = cap_explicit or cap_guess or ""

        if not indirizzo or not comune or not stato:
            return None

        return AddressData(
            indirizzo=indirizzo,
            cap=cap,
            comune=comune,
            provincia="",
            stato_estero=stato,
        )
```

Nota: `_RE_FOREIGN` va rimossa dalla classe (non più referenziata) — verifica con `grep -n "_RE_FOREIGN" app/pdf_extractor.py` che non resti alcun riferimento orfano dopo la modifica.

- [ ] **Step 5: Esegui i test e verifica che passino**

```bash
cd services/pdf-extractor && python3 -m pytest tests/test_pdf_extractor.py -v
```

Expected: PASS su tutti i test (esistenti + nuovi) — incluso `test_extract_address_domestic`/`test_extract_address_residenza_label`/`test_extract_address_missing_raises` (nessuna regressione sul ramo domestico, invariato).

- [ ] **Step 6: Esegui l'intera suite pytest del servizio**

```bash
cd services/pdf-extractor && python3 -m pytest tests/ -v
```

Expected: PASS su tutti i test (inclusi quelli su `extract_payment`, non toccati da questo task).

- [ ] **Step 7: Commit**

```bash
git add services/pdf-extractor/app/pdf_extractor.py services/pdf-extractor/tests/conftest.py services/pdf-extractor/tests/test_pdf_extractor.py
git commit -m "$(cat <<'EOF'
fix(pdf-extractor): riscrive parsing indirizzo estero a segmenti

_RE_FOREIGN assumeva un formato fisso "via - CAP comune - stato" che non
regge sulle varianti reali (CAP 4/5 cifre, CAP incorporato nella via,
pseudocodice a 5 cifre scambiato per CAP, parentetiche ripetute). Bug reale
confermato su un documento Maggioli reale (Svizzera): CAP vero perso dentro
la via, pseudocodice interno letto come CAP. Nuovo parsing a segmenti
testato su 10 documenti reali (Belgio/Svizzera/Germania/Canada).
EOF
)"
```

---

## Task 7: Frontend-admin — `countryColumn` nel wizard bulk (mapping + validazione)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `COUNTRIES`, `matchCountry` da `@comunicapa/shared-types` (Task 1).
- Produces: nuovo state `wizPostalCountryColumn`; `physicalAddressConfig.countryColumn` propagato in `buildWizChannelConfigDraft`/`handleWizLaunch`.

- [ ] **Step 1: Import e nuovo state**

Aggiungi in cima ad `apps/frontend-admin/src/App.tsx`, vicino agli altri import:

```typescript
import { COUNTRIES, matchCountry } from '@comunicapa/shared-types';
```

Aggiungi lo state accanto a `wizPostalProvinceColumn` (cerca `const [wizPostalProvinceColumn` con grep per la riga esatta):

```typescript
  const [wizPostalCountryColumn, setWizPostalCountryColumn] = useState('');
```

- [ ] **Step 2: Aggiungi il 5° select nella UI di mapping**

Trova il blocco JSX dei 4 select `physicalAddressConfig` (bulk mapping, POSTAL e SEND — cerca `wizPostalProvinceColumn}` per individuare il `<select>` esistente della provincia) e aggiungi subito dopo, stesso pattern/classi CSS del select provincia:

```tsx
                    <div className="col-md-6">
                      <label className="form-label small fw-semibold">Colonna Paese (facoltativa)</label>
                      <select
                        className="form-select form-select-sm"
                        value={wizPostalCountryColumn}
                        onChange={(e) => setWizPostalCountryColumn(e.target.value)}
                      >
                        <option value="">-- Nessuna (indirizzo sempre domestico) --</option>
                        {wizCsvHeaders.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                      <div className="form-text small">Se non mappata, tutti i destinatari sono trattati come domestici (Italia).</div>
                    </div>
```

Verifica con `grep -n "wizPostalProvinceColumn" apps/frontend-admin/src/App.tsx` quante volte questo blocco selettori è renderizzato (per POSTAL e per SEND potrebbero essere JSX separati) — replica l'aggiunta in OGNI occorrenza del blocco di mapping fisico (stesso gotcha noto: campi duplicati nel wizard vanno tenuti sincronizzati a mano).

- [ ] **Step 3: Propaga in `buildWizChannelConfigDraft`/bozza**

In `apps/frontend-admin/src/App.tsx`, ai 3 punti individuati dove `physicalAddressConfig` viene costruito (righe 5186-5189, 5210-5213, 5564-5567, 5589-5592 — 4 occorrenze totali: bozza+lancio, per POSTAL e SEND), aggiungi `countryColumn: wizPostalCountryColumn,` accanto agli altri campi:

```typescript
          addressColumn: wizPostalAddressColumn,
          municipalityColumn: wizPostalMunicipalityColumn,
          zipColumn: wizPostalZipColumn,
          provinceColumn: wizPostalProvinceColumn,
          countryColumn: wizPostalCountryColumn,
```

Verifica con `grep -n "provinceColumn: wizPostalProvinceColumn" apps/frontend-admin/src/App.tsx` di aver coperto TUTTE le occorrenze (gotcha noto: `handleWizLaunch` e `buildWizChannelConfigDraft` sono punti separati che vanno tenuti allineati a mano, vedi CLAUDE.md "Allegati e co-consegna App IO").

- [ ] **Step 4: Ripristino in `prefillWizardFrom`**

Trova dove vengono ripristinati `wizPostalAddressColumn`/`wizPostalProvinceColumn` da `source.channelConfig?.physicalAddressConfig` in `prefillWizardFrom` (righe vicine a 4967-4970) e aggiungi:

```typescript
    setWizPostalCountryColumn(source.channelConfig?.physicalAddressConfig?.countryColumn || '');
```

Cerca anche un eventuale reset in `resetWizard()` per gli stessi 4 state (`wizPostalAddressColumn` ecc.) — se presente, aggiungi `setWizPostalCountryColumn('');` allo stesso punto.

- [ ] **Step 5: Estendi la validazione bulk (righe 4655-4776)**

Nel blocco `useEffect` di validazione (righe 4753-4766, dentro `if (wizChannel === 'POSTAL') { ... }`), fai due modifiche:

a) Correggi il check CAP esistente (riga 4762) per non richiedere il formato 5-cifre quando la riga è estera — leggi prima il valore paese della riga:

```typescript
      if (wizChannel === 'POSTAL' || wizChannel === 'SEND') {
        const rawCountryVal = wizPostalCountryColumn ? (row[wizPostalCountryColumn]?.trim() || '') : '';
        const matchedCountry = rawCountryVal ? matchCountry(rawCountryVal) : null;
        const isForeignRow = !!matchedCountry && matchedCountry !== 'Italia';

        if (rawCountryVal && !matchedCountry) {
          errors.push({ row: rowNum, field: 'Paese', val: rawCountryVal, err: `Paese "${rawCountryVal}" non riconosciuto: record escluso dall'invio.` });
          isRowValid = false;
        }

        if (wizChannel === 'POSTAL') {
          if (wizPostalAddressColumn && !row[wizPostalAddressColumn]?.trim()) {
            errors.push({ row: rowNum, field: 'Indirizzo', val: '', err: 'Indirizzo mancante (obbligatorio per Postalizzazione)' });
            isRowValid = false;
          }
          if (wizPostalMunicipalityColumn && !row[wizPostalMunicipalityColumn]?.trim()) {
            errors.push({ row: rowNum, field: 'Città', val: '', err: 'Città mancante (obbligatoria per Postalizzazione)' });
            isRowValid = false;
          }
          if (
            !isForeignRow &&
            wizPostalZipColumn && row[wizPostalZipColumn]?.trim() && !isValidCap(row[wizPostalZipColumn])
          ) {
            errors.push({ row: rowNum, field: 'CAP', val: row[wizPostalZipColumn], err: 'CAP non valido (richieste 5 cifre)' });
            isRowValid = false;
          }

          if (isForeignRow) {
            const activeProvider = postalProviders.find(p => p.active);
            const contrattoAttivo = activeProvider?.contratti.find(c => wizPostalServiceType.startsWith(c.tipologia) && c.codiceContratto === (wizPostalCodiceContratto || activeProvider.contratti.find(cc => wizPostalServiceType.startsWith(cc.tipologia))?.codiceContratto));
            if (!contrattoAttivo?.estero) {
              errors.push({ row: rowNum, field: 'Paese', val: matchedCountry || rawCountryVal, err: 'Indirizzo estero ma il contratto POSTAL configurato non supporta spedizioni estero: record escluso dall\'invio.' });
              isRowValid = false;
            }
          }
        }
      }
```

Sostituisci l'intero blocco `if (wizChannel === 'POSTAL') { ... }` esistente (righe 4753-4766) con quanto sopra — nota che il nuovo blocco copre sia POSTAL sia SEND per il check paese, ma il check indirizzo/CAP/contratto resta specifico POSTAL (`SEND` non ha gate di contratto, vedi Task 2).

b) Aggiungi `wizPostalCountryColumn`, `postalProviders`, `wizPostalServiceType`, `wizPostalCodiceContratto` alle dipendenze del `useEffect` (riga 4776):

```typescript
  }, [wizCsvRows, wizMapping, wizChannel, wizAppIoInvolved, wizPostalAddressColumn, wizPostalMunicipalityColumn, wizPostalZipColumn, wizPostalCountryColumn, postalProviders, wizPostalServiceType, wizPostalCodiceContratto]);
```

- [ ] **Step 6: Type-check frontend**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 7: Verifica manuale nel browser**

```bash
docker compose up -d --build frontend-admin
```

Apri il wizard nuova campagna POSTAL, carica un CSV con una colonna "paese" (valori: vuoto, "Italia", "Belgio", "Paese Inesistente"), mappa la colonna nel nuovo select, verifica:
- righe "Italia"/vuote: nessun errore, CAP italiano validato normalmente.
- riga "Belgio" con CAP a 4 cifre: nessun errore CAP (bypassato per riga estera).
- riga "Paese Inesistente": errore mostrato in tabella, riga esclusa da "Record validi pronti".
- riga estera con contratto POSTAL configurato senza `Estero:true`: errore "contratto ... non supporta spedizioni estero".

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(frontend-admin): mapping colonna Paese nel wizard bulk POSTAL/SEND

Nuovo select countryColumn (facoltativo, retrocompatibile), validazione
righe con paese non riconosciuto o indirizzo estero su contratto POSTAL
senza capability Estero — stesso pattern skip-riga già usato per altri
campi non validi (record escluso, non bloccante per gli altri).
EOF
)"
```

---

## Task 8: Frontend-admin — badge capability Estero (scelta canale/servizio + Impostazioni)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `PostalProviderItem.contratti[].estero` (Task 3, già propagato via API — nessuna modifica backend aggiuntiva).

- [ ] **Step 1: Aggiorna il tipo `PostalProviderItem`**

Trova la definizione del tipo (riga vicina a 869):

```typescript
  contratti: Array<{ codiceContratto: string; descrizione: string; tipologia: string }>;
```

Sostituisci con:

```typescript
  contratti: Array<{ codiceContratto: string; descrizione: string; tipologia: string; estero: boolean }>;
```

- [ ] **Step 2: Badge nel pannello Impostazioni → Postalizzazione**

Trova il blocco che elenca i contratti (riga vicina a 3763, `p.contratti.map((c) => ...)`), aggiungi un badge accanto a `c.tipologia`:

```tsx
                                      {p.contratti.map((c) => (
                                        <div key={c.codiceContratto} className="small">
                                          <code>{c.codiceContratto}</code> — {c.descrizione} ({c.tipologia})
                                          {c.estero
                                            ? <span className="badge bg-success-subtle text-success-emphasis border border-success-subtle ms-1">Estero abilitato</span>
                                            : <span className="badge bg-secondary-subtle text-secondary-emphasis border border-secondary-subtle ms-1">Solo Italia</span>}
                                        </div>
                                      ))}
```

(Adatta al markup JSX esatto già presente in quel blocco — leggi le righe 3759-3770 prima di scrivere l'edit per non alterare la struttura esistente, aggiungi solo il badge.)

- [ ] **Step 3: Badge nello step scelta servizio POSTAL del wizard**

Trova i due punti (righe vicine a 7446-7448 e 8026-8028) dove `contrattiPerTipo` viene calcolato:

```typescript
                          const activeProvider = postalProviders.find((p) => p.active);
                          const contrattiPerTipo = activeProvider?.contratti.filter((c) => wizPostalServiceType.startsWith(c.tipologia)) ?? [];
```

Subito dopo (in entrambi i punti), aggiungi il rendering di un alert se NESSUNO dei contratti disponibili per quel `Tipologia` supporta estero:

```tsx
                          {contrattiPerTipo.length > 0 && contrattiPerTipo.every(c => !c.estero) && (
                            <div className="alert alert-warning py-2 small mt-2 mb-0">
                              <AlertCircle className="me-1" size={16} />
                              Il contratto configurato per questo Servizio non supporta l'estero: i destinatari con indirizzo estero verranno esclusi dall'invio (vedi mapping colonna Paese al Passo 3).
                            </div>
                          )}
```

Verifica che `AlertCircle` sia già importato (usato altrove nel file, es. riga 10662) — nessun nuovo import necessario.

- [ ] **Step 4: Type-check**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 5: Verifica manuale nel browser**

In Impostazioni → Postalizzazione, dopo un Test provider (ambiente con credenziali reali, o mock se disponibile in dev), verifica il badge "Estero abilitato"/"Solo Italia" sui contratti elencati. Nel wizard, seleziona un servizio POSTAL il cui contratto non ha `estero:true` e verifica l'alert.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(frontend-admin): badge capability Estero su contratti POSTAL

Visibile sia in Impostazioni (elenco contratti scoperti dal Test) sia
nello step scelta Servizio del wizard, prima ancora di caricare il CSV.
EOF
)"
```

---

## Task 9: Frontend-admin — invio singolo (`singleCountry`, gate, colonna sintetica)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Produces: nuovo state `singleCountry`; colonna sintetica `sd_paese` nel CSV a riga singola.

- [ ] **Step 1: Nuovo state**

Accanto a `singleProvince` (riga 1241):

```typescript
  const [singleCountry, setSingleCountry] = useState('Italia');
```

- [ ] **Step 2: Campo dropdown nel form invio singolo**

Trova il blocco JSX dei campi `singleAddress/singleMunicipality/singleZip/singleProvince` (cerca `onChange={(e) => setSingleProvince(e.target.value.toUpperCase())}`, riga vicina a 7605) e aggiungi subito dopo il `<div>` contenitore di quel campo:

```tsx
                              <div className="col-md-6">
                                <label className="form-label small fw-semibold">Paese</label>
                                <select
                                  className="form-select form-select-sm"
                                  value={singleCountry}
                                  onChange={(e) => setSingleCountry(e.target.value)}
                                >
                                  {COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                              </div>
```

- [ ] **Step 3: Rendi CAP/Provincia opzionali per indirizzo estero**

Modifica `wizSingleSubmitDisabled` (riga 4646):

```typescript
    (needsWizSinglePhysicalAddress && (
      !singleAddress.trim() || !singleMunicipality.trim()
      || (singleCountry === 'Italia' && (!singleZip.trim() || !isValidCap(singleZip) || !singleProvince.trim()))
    )) ||
```

- [ ] **Step 4: Propaga `singleCountry` nella CSV sintetica (`handleWizSingleSubmit`)**

Modifica il blocco righe 4582-4585:

```typescript
    if (needsWizSinglePhysicalAddress) {
      cols.push('sd_indirizzo', 'sd_comune', 'sd_cap', 'sd_provincia', 'sd_paese');
      vals.push(singleAddress, singleMunicipality, singleZip, singleProvince, singleCountry);
    }
```

Modifica il blocco righe 4602-4606:

```typescript
    if (needsWizSinglePhysicalAddress) {
      setWizPostalAddressColumn('sd_indirizzo');
      setWizPostalMunicipalityColumn('sd_comune');
      setWizPostalZipColumn('sd_cap');
      setWizPostalProvinceColumn('sd_provincia');
      setWizPostalCountryColumn('sd_paese');
    }
```

- [ ] **Step 5: Sync in `resetWizard`/`prefillWizardFrom`**

In `resetWizard()`, accanto a `setSingleProvince('');` (riga 4921):

```typescript
    setSingleCountry('Italia');
```

In `prefillWizardFrom`, dove vengono ripristinati `singleAddress`/`singleZip`/`singleProvince` da bozza (righe vicine a 5079-5082):

```typescript
              setSingleCountry(row['sd_paese'] || 'Italia');
```

- [ ] **Step 6: Type-check**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 7: Verifica manuale nel browser**

Wizard invio singolo POSTAL: seleziona un Paese estero nel dropdown, verifica che CAP/Provincia diventino facoltativi (bottone "Avanti" non più bloccato da CAP/Provincia vuoti). Con Paese "Italia" (default), verifica che il comportamento resti quello di oggi (CAP/Provincia obbligatori, formato CAP validato).

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(frontend-admin): campo Paese nel wizard invio singolo POSTAL/SEND

CAP/Provincia diventano facoltativi quando il Paese selezionato è estero
(coerente con SEND: zip facoltativo per invio estero, verificato su spec
PN). Colonna sintetica sd_paese propagata come le altre 4 (sd_indirizzo
ecc.) nel CSV a riga singola generato dal wizard.
EOF
)"
```

---

## Task 10: Frontend-admin — precompilazione da AIRE (ANPR)

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: `matchCountry` da `@comunicapa/shared-types` (Task 1), risposta `data.anpr.residenza[0].localitaEstera` già presente nell'API `/domicilio/cerca` (nessuna modifica backend).

- [ ] **Step 1: Aggiungi il ramo estero in `runWizAnprCheck`**

In `apps/frontend-admin/src/App.tsx`, subito dopo il blocco esistente (righe 4531-4540):

```typescript
      const residenza = data?.anpr?.residenza?.[0];
      if (data?.anpr?.success && data?.anpr?.found && residenza?.indirizzo) {
        const ind = residenza.indirizzo;
        const via = [ind.toponimo?.specie, ind.toponimo?.denominazioneToponimo].filter(Boolean).join(' ');
        const civico = [ind.numeroCivico?.numero, ind.numeroCivico?.lettera].filter(Boolean).join('');
        setSingleAddress([via, civico].filter(Boolean).join(', '));
        setSingleMunicipality(ind.comune?.nomeComune || '');
        setSingleZip(ind.cap || '');
        setSingleProvince(ind.comune?.siglaProvinciaIstat || '');
        setSingleCountry('Italia');
      } else if (data?.anpr?.success && data?.anpr?.found && residenza?.localitaEstera?.indirizzoEstero) {
        const ind = residenza.localitaEstera.indirizzoEstero;
        const via = [ind.toponimo?.denominazione, ind.toponimo?.numeroCivico].filter(Boolean).join(' ');
        const paeseRaw = ind.localita?.descrizioneStato || '';
        const matched = paeseRaw ? matchCountry(paeseRaw) : null;
        setSingleAddress(via);
        setSingleMunicipality(ind.localita?.descrizioneLocalita || '');
        setSingleZip(ind.cap || '');
        setSingleProvince('');
        setSingleCountry(matched || paeseRaw || 'Italia');
      }
```

Nota: sostituisce interamente il blocco `if (data?.anpr?.success && data?.anpr?.found && residenza?.indirizzo) { ... }` esistente, aggiungendo l'`else if` e `setSingleCountry('Italia')` esplicito nel ramo domestico (per azzerare un eventuale valore estero rimasto da una verifica precedente sullo stesso form).

- [ ] **Step 2: Badge "Compilato da AIRE"**

Trova il blocco JSX di visualizzazione AIRE in sola lettura (righe 10686-10701, `Residente estero (AIRE)`) — lascialo invariato (resta la card informativa read-only del pannello "Indirizzo Fisico (ANPR)"). Aggiungi invece un badge accanto al campo `singleCountry` nel form (Task 9, Step 2), visibile solo quando il valore corrente coincide con l'ultima verifica ANPR estera:

```tsx
                              <div className="col-md-6">
                                <label className="form-label small fw-semibold">
                                  Paese
                                  {singleAnprCheckedCf === singleCf && singleCountry !== 'Italia' && (
                                    <span className="badge bg-info-subtle text-info-emphasis border border-info-subtle ms-2">Compilato da AIRE</span>
                                  )}
                                </label>
                                <select
                                  className="form-select form-select-sm"
                                  value={singleCountry}
                                  onChange={(e) => setSingleCountry(e.target.value)}
                                >
                                  {COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
                                </select>
                              </div>
```

(Questo sostituisce il markup aggiunto nel Task 9 Step 2 — se i task vengono eseguiti in sequenza, applica questa versione con il badge invece di quella semplice del Task 9.)

- [ ] **Step 3: Type-check**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 4: Verifica manuale nel browser**

Wizard invio singolo, inserisci un CF di un soggetto AIRE (dev: usa il simulatore/mock ANPR se disponibile, altrimenti un CF reale in ambiente con credenziali ANPR configurate), clic "Verifica ANPR": verifica che Indirizzo/Comune/CAP/Paese si precompilino dai dati `localitaEstera`, badge "Compilato da AIRE" visibile, campi comunque editabili manualmente.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(frontend-admin): precompila indirizzo estero da AIRE (ANPR) nel wizard singolo

Stesso pattern già usato per l'override PEC da INAD: precompilazione
automatica ma sempre editabile, badge "Compilato da AIRE" per trasparenza
sull'origine del dato.
EOF
)"
```

---

## Task 11: Impostazioni — editor tabella abbreviazioni denominazione

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`

**Interfaces:**
- Consumes: chiave settings `notifiche.denominazioneAbbreviations` (Task 4, Step 7).

- [ ] **Step 1: Nuovo state per il testo JSON grezzo**

Trova dove vengono dichiarati gli state delle altre chiavi settings semplici (cerca `settSendTaxonomies` o un pattern simile con `useState`) e aggiungi:

```typescript
  const [settDenominazioneAbbreviationsText, setSettDenominazioneAbbreviationsText] = useState('[]');
  const [settDenominazioneAbbreviationsError, setSettDenominazioneAbbreviationsError] = useState('');
```

- [ ] **Step 2: Caricamento al fetch settings**

Trova il punto dove le altre chiavi vengono lette da `data` dopo il fetch di `/admin/settings` (stesso punto di `setSettSendTaxonomies(...)`, riga vicina a 1888) e aggiungi:

```typescript
          setSettDenominazioneAbbreviationsText(String(s['notifiche.denominazioneAbbreviations'] ?? '[]'));
```

- [ ] **Step 3: Salvataggio**

Trova il punto dove viene costruito l'oggetto da inviare a `PATCH /admin/settings` (stesso punto di `'send.enabledTaxonomyCodes': JSON.stringify(settSendTaxonomies)`, riga vicina a 2866) e aggiungi, con validazione prima dell'invio:

```typescript
    'notifiche.denominazioneAbbreviations': settDenominazioneAbbreviationsText,
```

Nel gestore submit del form Impostazioni (cerca `handleSaveSettings`), aggiungi una validazione JSON PRIMA della chiamata `PATCH`, mostrando l'errore invece di salvare un JSON non valido:

```typescript
    try {
      JSON.parse(settDenominazioneAbbreviationsText || '[]');
      setSettDenominazioneAbbreviationsError('');
    } catch {
      setSettDenominazioneAbbreviationsError('JSON non valido nella tabella abbreviazioni denominazione — correggi prima di salvare.');
      return;
    }
```

(Inserisci questo controllo all'inizio di `handleSaveSettings`, prima delle altre operazioni — leggi la funzione esistente per capire dove iniziano le chiamate di rete, ed inserisci subito prima.)

- [ ] **Step 4: UI — textarea nella tab Impostazioni generali (non Postale, chiave cross-canale)**

Trova una tab/sezione generica di Impostazioni (non "Postalizzazione", che è gestita da `postal-providers` API separata — cerca una sezione tipo "Notifiche"/"Generali" nel form `<form onSubmit={handleSaveSettings}>`) e aggiungi:

```tsx
                <div className="mb-3">
                  <label className="form-label small fw-semibold">
                    Abbreviazioni denominazione destinatario (POSTAL/SEND)
                  </label>
                  <textarea
                    className={`form-control font-monospace small ${settDenominazioneAbbreviationsError ? 'is-invalid' : ''}`}
                    rows={4}
                    value={settDenominazioneAbbreviationsText}
                    onChange={(e) => setSettDenominazioneAbbreviationsText(e.target.value)}
                  />
                  {settDenominazioneAbbreviationsError && (
                    <div className="invalid-feedback">{settDenominazioneAbbreviationsError}</div>
                  )}
                  <div className="form-text small">
                    JSON: {'[{"pattern": "testo da abbreviare", "replacement": "abbreviazione"}]'}. Applicato prima
                    di troncare un nome destinatario troppo lungo per Denominazione1/2 GlobalCom (44 char) o
                    denomination SEND (88 char) — es. dicitura legale eredi.
                  </div>
                </div>
```

**IMPORTANTE (gotcha noto, vedi CLAUDE.md "Frontend admin — mai `<form>` annidate"):** questo blocco va dentro il `<form onSubmit={handleSaveSettings}>` esistente della pagina Impostazioni, MAI in un `<form>` proprio — usa solo `<div>`, come sopra.

- [ ] **Step 5: Type-check**

```bash
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore.

- [ ] **Step 6: Verifica manuale nel browser**

In Impostazioni, verifica che la textarea mostri il default seed (`EREDI DI`), che un JSON malformato blocchi il salvataggio con messaggio d'errore visibile, che un JSON valido venga salvato e ricaricato correttamente al refresh pagina.

- [ ] **Step 7: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(frontend-admin): editor Impostazioni per tabella abbreviazioni denominazione

Textarea JSON validata prima del salvataggio (stesso pattern "mai form
annidate" del resto della pagina Impostazioni).
EOF
)"
```

---

## Task 12: Verifica finale end-to-end

**Files:** nessuno (solo verifica)

- [ ] **Step 1: Suite completa backend**

```bash
docker compose exec backend node_modules/.bin/jest --maxWorkers=2
```

Expected: stesso failure set noto (1 pre-esistente `app.controller.spec.ts`), zero nuove regressioni.

- [ ] **Step 2: Type-check completo**

```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```

Expected: nessun errore su entrambi.

- [ ] **Step 3: Suite pytest pdf-extractor**

```bash
cd services/pdf-extractor && python3 -m pytest tests/ -v
```

Expected: tutti PASS.

- [ ] **Step 4: Suite jest shared-types**

```bash
cd packages/shared-types && npx jest
```

Expected: tutti PASS.

- [ ] **Step 5: Rebuild completo Docker (verifica che nessuna dipendenza nuova rompa la build)**

```bash
docker compose build backend frontend-admin
docker compose up -d backend frontend-admin
docker compose logs --tail=50 backend frontend-admin
```

Expected: nessun errore di avvio, nessun `Cannot find module`.

- [ ] **Step 6: Test manuale end-to-end (invio singolo estero)**

Wizard POSTAL invio singolo → CF con verifica AIRE (o inserimento manuale Paese=Belgio, indirizzo/comune/CAP di test) → allegato → lancio test. Verifica in Impostazioni → Motori → log job che `Stato` sia stato inviato a GlobalCom (log debug, `LOG_LEVEL=debug`) o, se il contratto configurato non supporta estero, che il gate blocchi correttamente prima dell'invio.

- [ ] **Step 7: Aggiorna il design doc con eventuali scostamenti reali riscontrati**

Se il test dal vivo (Step 6) rivela che GlobalCom rifiuta `Stato` per Servizio non-telegramma nonostante `Estero:true` sul contratto (ipotesi da verificare, vedi Sezione 2 del design doc), aggiorna `docs/superpowers/specs/2026-07-28-indirizzo-estero-design.md` con l'esito reale e valuta se serve un fallback (es. warning "Servizio non supporta Stato, indirizzo inviato senza campo estero").

- [ ] **Step 8: Commit finale (se Step 7 ha prodotto modifiche)**

```bash
git add docs/superpowers/specs/2026-07-28-indirizzo-estero-design.md
git commit -m "docs(specs): aggiorna esito verifica dal vivo Stato GlobalCom su indirizzo estero"
```

---

## Self-Review

**Copertura spec (design doc, 6 sezioni):**
- Sezione 1 (modello dato Paese) → Task 1, 7, 9. ✓
- Sezione 2 (POSTAL: scoperta Estero, gate, mapping Stato) → Task 3, 4 (parte B), 7, 8. ✓
- Sezione 3 (SEND: foreignState) → Task 2 (nessun'altra modifica necessaria, spread automatico). ✓
- Sezione 4 (AIRE autofill) → Task 10. ✓
- Sezione 5 (fix `pdf_extractor.py`) → Task 6. ✓
- Sezione 6 (denominazione lunga) → Task 4 (parte A), 5, 11. ✓

**Placeholder scan:** nessun TBD/TODO residuo; ogni step ha codice completo o comando+output atteso.

**Type consistency:** `ResolvedPhysicalAddress.foreignState` (Task 2) → consumato as-is da `send-dispatch.service.ts` via spread (nessuna rinomina) e da `postal.strategy.ts` come `resolvedAddress.foreignState` (Task 4) → mappato su `GbcAddress.stato` (nome diverso perché il campo WSDL si chiama `Stato`, non `foreignState` — coerente con la convenzione esistente del file, es. `resolvedAddress.zip` → `GbcAddress.cap`). `GbcContratto.estero`/`PostalProviderConfig.contratti[].estero`/`PostalProviderContrattoDto.estero`/`PostalProviderItem.contratti[].estero` (Task 3, 8) → stesso nome in tutta la catena. `splitDenominazione()` (Task 4) → stessa firma riusata in Task 5.

**Gap noti/fuori scope (già dichiarati nel design doc):** nessuna estensione a verifica CAP-stradario esistente, nessuna gestione estero per App IO, nessuna modifica al comportamento INAD.
