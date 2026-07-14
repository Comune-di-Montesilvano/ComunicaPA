# SEND Settings: tipologia ente + gruppi PN Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nel pannello Impostazioni → SEND, sostituire l'inserimento manuale di codice+label tassonomia con una scelta guidata da tabella ufficiale filtrata per tipologia ente, e sostituire il campo libero "Gruppo PN" con una droplist che interroga l'API reale di PN.

**Architecture:** Dato statico delle 12 tipologie ente + tutte le tassonomie ufficiali in un nuovo file frontend (`sendTaxonomy.ts`), usato per filtrare un select che alimenta l'array esistente `settSendTaxonomies` (nessuna migrazione dati). Nuovo endpoint backend `GET admin/settings/send/:env/groups` che proxya `{baseUrl}/ext-registry-b2b/pa/v1/groups` con solo header `x-api-key` (niente voucher PDND, confermato da spec ufficiale `pn-external-registries`), consumato da un bottone "Carica gruppi" nel frontend che popola una select scrivendo l'id nel campo `send.{env}.group` esistente.

**Tech Stack:** NestJS 10 (backend), React 19 + Vite (frontend-admin), Jest per i test backend.

## Global Constraints

- Test suite backend: SEMPRE `--maxWorkers=2` (RAM WSL2).
- Reverse proxy esterno in produzione sostituisce body risposte non-2xx: l'endpoint groups deve rispondere sempre HTTP 200 con `{ groups: [], error: '...' }` in caso di errore, mai eccezioni HTTP non-2xx per errori "previsti" (apiKey mancante, chiamata upstream fallita).
- `send.{env}.group` resta l'unico setting per il gruppo (stringa, id PN) — nessuna migrazione DB, nessun nuovo campo persistito per i gruppi.
- Nessuna chiamata di rete per le tassonomie: dato statico versionato col codice.
- Placeholder delimitatore/altre convenzioni codice esistenti (naming `sett*`, `handle*`) da rispettare esattamente come nei pattern già presenti in `App.tsx`.

---

### Task 1: Setting `send.entityType` nel registry backend

**Files:**
- Modify: `apps/backend/src/settings/settings.registry.ts:56` (dopo `'send.senderTaxId'`)

**Interfaces:**
- Consumes: nessuna (chiave registry standalone).
- Produces: chiave `'send.entityType'` disponibile via `AppSettingsService.get<string>('send.entityType')`, letta/scritta dal frontend come le altre chiavi SEND (stringa `'01'`..`'12'` o `''`).

- [ ] **Step 1: Aggiungere la chiave al registry**

In `apps/backend/src/settings/settings.registry.ts`, subito dopo la riga `'send.senderTaxId': { type: 'string', default: '' },` (riga 56), aggiungere:

```ts
  'send.entityType': { type: 'string', default: '' },
```

- [ ] **Step 2: Verifica type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore (la chiave è solo un nuovo membro di `SETTING_DEFS`, nessun consumer da aggiornare in questo task).

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/settings/settings.registry.ts
git commit -m "feat(backend): aggiunge setting send.entityType per tipologia ente SEND"
```

---

### Task 2: Dato statico tassonomie SEND (frontend)

**Files:**
- Create: `apps/frontend-admin/src/data/sendTaxonomy.ts`

**Interfaces:**
- Consumes: nessuna.
- Produces:
  - `export interface SendTaxonomyEntry { code: string; entityType: string; title: string; description: string }`
  - `export const SEND_ENTITY_TYPES: { code: string; label: string }[]` (12 voci, codice a 2 cifre + label)
  - `export const SEND_TAXONOMY_CATALOG: SendTaxonomyEntry[]` (tutte le voci, tutte le 12 tipologie)
  - Consumato da Task 4 (`App.tsx`).

- [ ] **Step 1: Creare il file dati**

Creare `apps/frontend-admin/src/data/sendTaxonomy.ts` con questo contenuto esatto:

```ts
// Tassonomia SEND ufficiale v2.5 — fonte:
// https://raw.githubusercontent.com/pagopa/devportal-docs-translations/a5e20810a6a3b0d6d733f955c4c3ff980e22b764/docs/3FyVXetkmOApT9WPTwPN/tassonomia-send.md
// Verificato 2026-07-14. Dato di riferimento statico: aggiornare a mano se
// pagopa pubblica nuove voci (nessuna chiamata di rete).

export interface SendTaxonomyEntry {
  code: string;
  entityType: string;
  title: string;
  description: string;
}

export const SEND_ENTITY_TYPES: { code: string; label: string }[] = [
  { code: '01', label: 'Comune' },
  { code: '02', label: 'Regioni ed Enti Regionali' },
  { code: '03', label: 'Riscossore' },
  { code: '04', label: 'Ministeri' },
  { code: '05', label: 'Previdenza' },
  { code: '06', label: 'Servizio Sanitario Nazionale' },
  { code: '07', label: 'Provincia' },
  { code: '08', label: "Università/ Scuola statale/ Altri Enti" },
  { code: '09', label: 'Camera di Commercio' },
  { code: '10', label: 'Ordine Professionale' },
  { code: '11', label: 'Gestore di Pubblico Servizio' },
  { code: '12', label: 'Società a Controllo Pubblico' },
];

export const SEND_TAXONOMY_CATALOG: SendTaxonomyEntry[] = [
  // 01 - Comune
  { code: '010101P', entityType: '01', title: 'Notifiche Violazioni al Codice della Strada', description: "Tutte le tipologie di comunicazioni/verbali/solleciti relative a violazione al CdS (divieto di sosta, autovelox, ztl etc...)" },
  { code: '010102P', entityType: '01', title: 'Notifiche Violazioni extra CdS', description: "Tutte le tipologie di comunicazioni relative a violazioni extra CdS (sanzioni ambientali, altre sanzioni amministrative etc...)" },
  { code: '010103N', entityType: '01', title: 'Notifiche Violazioni al Codice della Strada', description: "Tutte le tipologie di comunicazioni/verbali/solleciti relative a violazione al CdS (divieto di sosta, autovelox, ztl etc...)" },
  { code: '010104N', entityType: '01', title: 'Notifiche Violazioni extra CdS', description: "Tutte le tipologie di comunicazioni relative a violazioni extra CdS (sanzioni ambientali, altre sanzioni amministrative etc...)" },
  { code: '010201P', entityType: '01', title: 'Notifiche Riscossione Tributi con pagamento', description: "Tutte le tipologie di comunicazione associate ad un pagamento (es: accertamenti, solleciti etc...) relative a Tributi che l'Ente deve incassare dal cittadino/impresa (IMU, TASI, TARI, IDRICO etc...)" },
  { code: '010202N', entityType: '01', title: 'Notifiche Riscossione Tributi senza pagamento', description: "Tutte le tipologie di comunicazione che non prevedono un pagamento correlato (es: rettifica/annullamento dell'accertamento, atto di invito a comparire per accertamento con adesione, questionario e censimento lg. 147/2013, controllo su planimetria abitazione, revisione rendite catastali lg 336, stipula/cessazione contratto idrico, atto di messa in mora etc...) relative a Tributi che l'Ente incassa dal cittadino/impresa (IMU, TASI, TARI, IDRICO etc...)" },
  { code: '010301P', entityType: '01', title: 'Notifiche riscossione entrate patrimoniali con pagamento', description: 'Tutte le tipologie di comunicazione associate ad un pagamento (es. notifica/sollecito rata affitti) relative a entrate patrimoniali che l\'Ente incassa dal cittadino/impresa' },
  { code: '010302N', entityType: '01', title: 'Notifiche riscossione entrate patrimoniali senza pagamento', description: "Tutte le tipologie di comunicazione che non prevedono un pagamento correlato (es. rettifica annullamento, stipula, determinazione canone, richiesta dati reddituali, cessazione contratto etc..) relative ad entrate patrimoniali che l'Ente incassa dal cittadino/impresa" },
  { code: '010401P', entityType: '01', title: 'Notifiche per sollecito pagamento servizi scolastici', description: 'Tutte le tipologie di comunicazione relative al sollecito di pagamento servizi scolastici (es. mense, trasporto, rette, pre post scuola etc...)' },
  { code: '010401N', entityType: '01', title: 'Notifiche Atti Servizi Scolastici', description: 'Tutte le tipologie di comunicazione relative al sollecito di pagamento servizi scolastici (es. mense, trasporto, rette, pre post scuola etc...)' },
  { code: '010501N', entityType: '01', title: 'Notifiche comunicazioni VL relative ad ufficio anagrafe', description: 'Tutte le tipologie di provvedimenti e notifiche emessi da Ufficio Anagrafe vs. cittadini e imprese (es. provvedimento di irreperibilità, nomina presidente/scrutatore di seggio, convocazione per giuramento cittadinanza, accesso agli atti etc...)' },
  { code: '010601N', entityType: '01', title: 'Notifiche comunicazioni VL Ufficio Tecnico / SUAP', description: 'Tutte le tipologie di atti inviati a imprese/cittadini per procedimenti attivati c/o Ufficio Tecnico / SUAP (es. richiesta parere altri uffici, SCIA accoglimento/diniego, comunicazioni e autorizzazioni accoglimento/diniego etc...)' },
  { code: '010701P', entityType: '01', title: 'Ordinanze Comunali con pagamento', description: 'Notifica Ordinanza ingiunzione (es. sanzioni amministrative varie)' },
  { code: '010702N', entityType: '01', title: 'Ordinanze Comunali senza pagamento', description: 'Notifiche Ordinanze (es. ordinarie, per casi eccezionali di particolare gravità, contingibili e urgenti, etc...)' },
  { code: '010801N', entityType: '01', title: 'Comunicazioni relative a riscossioni coattive e ingiunzioni fiscali', description: 'Notifica atti relativi a procedimenti di riscossione coattiva / ingiunzioni fiscali (es. preavviso fermo amministrativo, preavviso iscrizione ipoteca, avviso di intimazione)' },
  { code: '010801P', entityType: '01', title: 'Comunicazioni relative a riscossioni coattive e ingiunzioni fiscali', description: 'Notifica atti relativi a procedimenti di riscossione coattiva / ingiunzioni fiscali (es. preavviso fermo amministrativo, preavviso iscrizione ipoteca, avviso di intimazione)' },
  { code: '010901N', entityType: '01', title: 'notifica delegazioni di pagamento a tesoriere', description: 'a notificare al tesoriere i documenti richiesti da cddpp' },
  { code: '011001N', entityType: '01', title: 'notifica atti di convocazione consiglio comunale', description: 'per notificare ai vari consiglieri comunali la convocazione del consiglio' },
  // 02 - Regioni ed Enti Regionali
  { code: '020101P', entityType: '02', title: 'Notifiche Riscossione Bollo non pagato', description: "Tutte le comunicazione associate ad un pagamento (es: accertamenti, solleciti etc...) relative al recupero dei Bolli non pagati degli anni precedenti che l'Ente deve incassare dal cittadino/impresa." },
  { code: '020401P', entityType: '02', title: 'Notifiche Istanze di diniego/accettazione esenzione', description: 'Tutte le comunicazioni, di diniego, di accettazione o di carenza di documentazione, che riguardano le istanze di esenzione per il pagamento del bollo auto presentate da soggetti ex art. 3, co.3, l. 104/92, invalide, etc...' },
  { code: '020402N', entityType: '02', title: 'Notifiche Istanze di diniego/accettazione esenzione', description: 'Tutte le comunicazioni, di diniego, di accettazione o di carenza di documentazione, che riguardano le istanze di esenzione per il pagamento del bollo auto presentate da soggetti ex art. 3, co.3, l. 104/92, invalide, etc...' },
  { code: '020403N', entityType: '02', title: 'Notifica Tasse per Sospensione Rivenditori', description: 'Tutte le comunicazioni che riguardano il contributo da versare in relazione alla sospensione del bollo auto per rivendita' },
  // 03 - Riscossore
  { code: '030101P', entityType: '03', title: 'Notifiche Riscossione Tributi con pagamento', description: "Tutte le tipologie di comunicazione associate ad un pagamento (es: accertamenti, solleciti etc...) relative a Tributi che l'Ente deve incassare dal cittadino/impresa (IMU, TASI, TARI, IDRICO etc...)" },
  { code: '030102N', entityType: '03', title: 'Notifiche Riscossione Tributi senza pagamento', description: "Tutte le tipologie di comunicazione che non prevedono un pagamento correlato relative a Tributi che l'Ente incassa dal cittadino/impresa (IMU, TASI, TARI, IDRICO etc...)" },
  { code: '030201P', entityType: '03', title: 'Notifiche riscossione entrate patrimoniali con pagamento', description: "Tutte le tipologie di comunicazione associate ad un pagamento (es. notifica/sollecito rata affitti, ICP, CANONE UNICO PATRIMONIALE, OCCUPAZIONE SUOLO PUBBLICO, etc...) relative a entrate patrimoniali che l'Ente incassa dal cittadino/impresa" },
  { code: '030202N', entityType: '03', title: 'Notifiche riscossione entrate patrimoniali senza pagamento', description: "Tutte le tipologie di comunicazione che non prevedono un pagamento correlato (es. rettifica annullamento, stipula, determinazione canone, richiesta dati reddituali, cessazione contratto etc..) relative a entrate patrimoniali che l'Ente incassa dal cittadino/impresa" },
  { code: '030301P', entityType: '03', title: 'Comunicazioni relative a riscossioni coattive e ingiunzioni fiscali', description: 'Tutte le tipologie di comunicazioni associate ad un pagamento che prevedono la notifica di atti relativi a procedimenti di riscossione coattiva / ingiunzioni fiscali' },
  { code: '030302N', entityType: '03', title: 'Comunicazioni relative a riscossioni coattive e ingiunzioni fiscali', description: 'Notifica atti relativi a procedimenti di riscossione coattiva / ingiunzioni fiscali' },
  { code: '030401P', entityType: '03', title: 'Comunicazioni relative a processi amministrativi di accesso agli atti', description: "Tutte le tipologie di comunicazioni associate ad un pagamento rispetto alla erogazione del servizio di accesso agli atti dell'Ente" },
  { code: '030402N', entityType: '03', title: 'Comunicazioni relative a processi amministrativi di accesso agli atti', description: "Notifiche di atti relativi a procedimenti relativi alla richiesta di accesso agli atti dell'Ente (conferma, diniego, rifiuto, etc...)" },
  { code: '030501N', entityType: '03', title: 'Comunicazioni relative ad ufficio SUAP e Commercio', description: 'Tutte le tipologie di comunicazioni associate ad un pagamento che prevedono la notifica di atti c/o ufficio tecnico (Richiesta parere altri uffici, SCIA - Accoglimento/Diniego, Comunicazioni, Accoglimento/Diniego Autorizzazioni, etc...)' },
  { code: '030601P', entityType: '03', title: 'Notifiche Riscossione Bollo non pagato', description: "Tutte le comunicazione associate ad un pagamento relative al recupero dei Bolli non pagati degli anni precedenti che l'Ente deve incassare dal cittadino/impresa." },
  // 04 - Ministeri
  { code: '040101N', entityType: '04', title: 'Notifica di concessione/diniego di cittadinanza', description: 'Notifiche di atti relativi a procedimenti inerenti a richieste di cittadinanza' },
  { code: '040201N', entityType: '04', title: 'Comunicazione di avvio del procedimento', description: 'Costituzione in mora – Comunicazione di avvio del procedimento' },
  // 05 - Previdenza
  { code: '050101P', entityType: '05', title: "Notifiche relative a Contributi verso l'ente previdenziale", description: "Notifiche relative a Contributi verso l'ente previdenziale (es. Riscatti, Ricongiunzione e Rendite, Versamenti Volontari, Lavoratori Domestici)" },
  { code: '050201N', entityType: '05', title: 'Notifiche dei Provvedimenti dei prodotti/servizi', description: 'Notifiche dei provvedimenti dei prodotti/servizi (es. Riscatti, Ricongiunzione e Rendite, Assegno di Inclusione, Supporto Formazione e Lavoro)' },
  { code: '050201P', entityType: '05', title: 'Notifiche dei Provvedimenti dei prodotti/servizi', description: 'Notifiche dei provvedimenti dei prodotti/servizi (es. Riscatti, Ricongiunzione e Rendite, Assegno di Inclusione, Supporto Formazione e Lavoro)' },
  { code: '050301N', entityType: '05', title: 'Notifiche dei provvedimenti di recupero indebiti', description: 'Notifiche dei provvedimenti di recupero indebiti da pensione, ammortizzatori sociali ed entrate' },
  { code: '050301P', entityType: '05', title: 'Notifiche dei provvedimenti di recupero indebiti', description: 'Notifiche dei provvedimenti di recupero indebiti da pensione, ammortizzatori sociali ed entrate' },
  { code: '050401P', entityType: '05', title: 'Notifiche dei provvedimenti di recupero del credito', description: "Notifiche dei provvedimenti di recupero del credito emessi dall'Istituto Previdenziale e riscossi dall'Agenzia delle entrate-Riscossione" },
  // 06 - Servizio Sanitario Nazionale
  { code: '060101P', entityType: '06', title: 'Notifiche relative al Pagamento nei confronti della Sanità', description: 'Tutte le tipologie di notifiche che riguardano il pagamento di una tassa per usufruire del servizio sanitario pubblico' },
  { code: '060201P', entityType: '06', title: 'Notifiche recupero crediti in seguito ad errate dichiarazioni di esenzione da reddito', description: 'Tutte le comunicazioni associate ad un pagamento, relative al recupero del ticket dovuto per le prestazioni di assistenza specialistica e/o farmaceutica fruite indebitamente' },
  // 07 - Provincia
  { code: '070101P', entityType: '07', title: 'Notifiche Violazioni al Codice della Strada', description: 'Tutte le tipologie di comunicazioni/verbali/solleciti relative a violazione al CdS in ambito provinciale (ex. autovelox, etc...)' },
  { code: '070201P', entityType: '07', title: 'Notifiche Violazioni extra CdS', description: 'Inviare le notifiche Extra Cds per le Province' },
  { code: '070202N', entityType: '07', title: 'Notifiche Violazioni extra CdS', description: 'Inviare le notifiche Extra Cds per le Province' },
  { code: '070301P', entityType: '07', title: 'Ordinanze Provinciali', description: 'Inviare le notifiche Extra Cds per le Province' },
  { code: '070302N', entityType: '07', title: 'Ordinanze Provinciali', description: 'Inviare le notifiche Extra Cds per le Province' },
  // 08 - Università/ Scuola statale/ Altri Enti
  { code: '080101N', entityType: '08', title: 'Revoca dei benefici per mancanza di requisiti', description: 'Comunicazione amministrativa di revoca per perdita dei requisiti di accesso ai benefici e richiesta di rientro delle somme percepite' },
  { code: '080102N', entityType: '08', title: 'Remissione del credito art. 1236 codice civile', description: "Sollecito a comunicare il Codice IBAN per l'accredito della Borsa di Studio a pena di remissione del credito in caso di inadempienza" },
  { code: '080201N', entityType: '08', title: 'Accertamento economico-patrimoniale', description: 'Comunicazione amministrativa di avvio procedimento per accertamento di sussistenza dei requisiti che danno diritto ai benefici concessi' },
  // 09 - Camera di Commercio
  { code: '090101P', entityType: '09', title: 'Servizio di notifiche digitali per Verbali e Ordinanze', description: 'Ingiungere gli importi dovuti a seguito di sanzioni amministrative (registro imprese e di altri organi accertatori)' },
  // 10 - Ordine Professionale
  { code: '100101P', entityType: '10', title: 'Tassa Iscrizione Annua', description: 'Tutte le tipologie di comunicazioni associate al pagamento della Tassa di Iscrizione Annua che prevedono la notifica di atti relativi ai procedimenti di riscossione' },
  { code: '100102N', entityType: '10', title: 'Tassa Iscrizione Annua', description: 'Tutte le tipologie di comunicazioni associate alla Tassa di Iscrizione Annua' },
  { code: '100103P', entityType: '10', title: "Notifiche relative al Pagamento nei confronti dell'Ordine", description: 'Tutte le tipologie di comunicazioni associate ad un pagamento che prevedono la notifica di atti relativi a procedimenti di riscossione (Decreti ingiuntivi, etc)' },
  { code: '100104N', entityType: '10', title: "Notifiche relative al Pagamento nei confronti dell'Ordine", description: 'Tutte le tipologie di comunicazioni associate ad un pagamento che prevedono la notifica di atti relativi a procedimenti di riscossione (Decreti ingiuntivi, etc)' },
  { code: '100105P', entityType: '10', title: 'Notifiche atti amministrativi/contabili', description: "Tutte le tipologie di comunicazioni associate ad un pagamento rispetto alla erogazione del servizio di accesso agli atti dell'Ente" },
  { code: '100106N', entityType: '10', title: 'Notifiche atti amministrativi', description: "Notifiche di atti relativi a procedimenti amministrativi dell'Ente (Rigetti, Cancellazioni, Sospensioni, Diffide, etc…)" },
  { code: '100107N', entityType: '10', title: 'Avviso Morosità', description: 'Comunicazione relativa al sollecito di pagamento della Tassa di Iscrizione annua (primo, secondo e terzo avviso)' },
  // 11 - Gestore di Pubblico Servizio
  { code: '110101P', entityType: '11', title: 'Solleciti di Pagamento', description: 'Tutte le tipologie di sollecito clienti morosi' },
  // 12 - Società a Controllo Pubblico
  { code: '120101P', entityType: '12', title: 'Notifica Avviso di Pagamento', description: 'avviso di pagamento di una rata del finanziamento/contributo concesso' },
  { code: '120102P', entityType: '12', title: 'Notifica Solleciti di Pagamento', description: 'Sollecito avviso di pagamento di una o più rate scadute del finanziamento/contributo concesso' },
  { code: '120103P', entityType: '12', title: 'Notifica Atto di Ingiunzione', description: "Atto di ingiunzione alla restituzione del finanziamento e/o contributo concesso qualora l'intero ammontare non sia stato restituito a seguito di revoca nei tempi stabiliti" },
];
```

- [ ] **Step 2: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore (file nuovo, non ancora importato da nessuno).

- [ ] **Step 3: Commit**

```bash
git add apps/frontend-admin/src/data/sendTaxonomy.ts
git commit -m "feat(frontend-admin): aggiunge dato statico tassonomie SEND ufficiali v2.5"
```

---

### Task 3: Backend — endpoint elenco gruppi PN

**Files:**
- Modify: `apps/backend/src/settings/settings.controller.ts` (nuovo metodo dopo `testSendConnection`, circa riga 209)
- Test: `apps/backend/src/settings/settings.controller.spec.ts` (nuovo `describe` block dopo quello esistente su SEND test-connection, dopo riga 99)

**Interfaces:**
- Consumes: `AppSettingsService.get<string>(key)` (già iniettato nel controller come `this.appSettings`), `global.fetch`.
- Produces: `GET admin/settings/send/:env/groups` → `Promise<{ groups: { id: string; name: string; description: string; status: string }[]; error?: string }>`. Consumato da Task 4 (frontend).

- [ ] **Step 1: Scrivere il test che deve fallire**

Aggiungere in `apps/backend/src/settings/settings.controller.spec.ts`, dopo la riga 99 (fine del blocco `describe` esistente sul test-connection SEND), un nuovo blocco:

```ts
describe('SettingsController — SEND groups (elenco gruppi PN self-care)', () => {
  const mockFetch = jest.fn();
  global.fetch = mockFetch as unknown as typeof fetch;

  const values: Record<string, unknown> = {
    'send.test.baseUrl': 'https://send.test',
    'send.test.apiKey': '',
  };
  const settingsMock = { get: jest.fn(async (key: string) => values[key]) };
  const pdndAuthMock = { getVoucher: jest.fn(async () => 'voucher-abc') };
  const controller = new SettingsController(settingsMock as never, pdndAuthMock as never);

  beforeEach(() => {
    mockFetch.mockClear();
  });

  it('ritorna errore leggibile senza chiamare PN se apiKey non è configurata', async () => {
    values['send.test.apiKey'] = '';
    const res = await controller.getSendGroups('test');
    expect(res.groups).toEqual([]);
    expect(res.error).toContain('API Key');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('chiama solo x-api-key (nessun voucher PDND) e ritorna i gruppi ACTIVE', async () => {
    values['send.test.apiKey'] = 'apikey-real';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [
        { id: 'g1', name: 'Tributi', description: 'Ufficio tributi', status: 'ACTIVE' },
        { id: 'g2', name: 'Vecchio', description: 'Non più attivo', status: 'DELETED' },
      ],
    });

    const res = await controller.getSendGroups('test');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/ext-registry-b2b/pa/v1/groups?statusFilter=ACTIVE',
      { headers: { 'x-api-key': 'apikey-real' } },
    );
    expect(res.groups).toEqual([{ id: 'g1', name: 'Tributi', description: 'Ufficio tributi', status: 'ACTIVE' }]);
    expect(res.error).toBeUndefined();
  });

  it('ritorna errore leggibile (HTTP 200) se PN risponde con errore, senza lanciare eccezione', async () => {
    values['send.test.apiKey'] = 'apikey-invalid';
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

    const res = await controller.getSendGroups('test');

    expect(res.groups).toEqual([]);
    expect(res.error).toContain('403');
  });

  it('ritorna errore leggibile se la chiamata di rete fallisce', async () => {
    values['send.test.apiKey'] = 'apikey-real';
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    const res = await controller.getSendGroups('test');

    expect(res.groups).toEqual([]);
    expect(res.error).toBe('network down');
  });

  it('rifiuta env non valido con BadRequestException', async () => {
    await expect(controller.getSendGroups('staging')).rejects.toThrow('Ambiente non valido');
  });
});
```

- [ ] **Step 2: Eseguire i test e verificare che falliscano**

Run: `docker compose exec backend node_modules/.bin/jest settings.controller --maxWorkers=2`
Expected: FAIL — `controller.getSendGroups is not a function`

- [ ] **Step 3: Implementare l'endpoint**

In `apps/backend/src/settings/settings.controller.ts`, aggiungere l'import `Query` a fianco degli altri decorator NestJS già importati (riga 1-13):

```ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
```

Aggiungere subito dopo il metodo `testSendConnection` (dopo la riga 209, prima di `@Post('inad/:env/test-connection')`):

```ts
  @Get('send/:env/groups')
  @HttpCode(HttpStatus.OK)
  async getSendGroups(@Param('env') env: string): Promise<{ groups: Array<{ id: string; name: string; description: string; status: string }>; error?: string }> {
    // /ext-registry-b2b/pa/v1/groups (repo pn-external-registries) richiede
    // SOLO x-api-key — a differenza di /delivery/*, questo endpoint NON
    // richiede il voucher PDND (securitySchemes: solo ApiKeyAuth). Sempre
    // HTTP 200 anche in errore: il reverse proxy esterno in produzione
    // sostituisce il body delle risposte non-2xx (vedi CLAUDE.md).
    if (env !== 'test' && env !== 'prod') {
      throw new BadRequestException('Ambiente non valido: usare "test" o "prod"');
    }
    const baseUrl = await this.appSettings.get<string>(`send.${env}.baseUrl` as SettingKey);
    const apiKey = await this.appSettings.get<string>(`send.${env}.apiKey` as SettingKey);
    if (!apiKey) {
      return { groups: [], error: `API Key SEND (${env}) non configurata.` };
    }
    try {
      const res = await fetch(`${baseUrl}/ext-registry-b2b/pa/v1/groups?statusFilter=ACTIVE`, {
        headers: { 'x-api-key': apiKey },
      });
      if (!res.ok) {
        return { groups: [], error: `PN ha rifiutato la richiesta gruppi: HTTP ${res.status}.` };
      }
      const data = (await res.json()) as Array<{ id: string; name: string; description: string; status: string }>;
      return { groups: data.filter((g) => g.status === 'ACTIVE') };
    } catch (error: any) {
      return { groups: [], error: error.message || 'Errore sconosciuto durante il recupero dei gruppi PN.' };
    }
  }
```

- [ ] **Step 4: Eseguire i test e verificare che passino**

Run: `docker compose exec backend node_modules/.bin/jest settings.controller --maxWorkers=2`
Expected: PASS (tutti i test del file, inclusi quelli preesistenti)

- [ ] **Step 5: Type-check backend**

Run: `docker compose exec backend node_modules/.bin/tsc --noEmit`
Expected: nessun errore

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/settings/settings.controller.ts apps/backend/src/settings/settings.controller.spec.ts
git commit -m "feat(backend): endpoint GET admin/settings/send/:env/groups (elenco gruppi PN self-care)"
```

---

### Task 4: Frontend — selettore tipologia ente + aggiunta tassonomia guidata

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`
  - Import nuovo file dati (vicino agli altri import, inizio file)
  - Nuovo state `settSendEntityType` (vicino a riga 613, dopo `settSendTaxonomies`)
  - Lettura/scrittura in `buildSettingsPayload`/caricamento settings (righe ~789-803 e ~1355-1365)
  - Nuovo state locale `wizAddTaxonomyCode` per il select di scelta (dichiarato vicino a `settSendEntityType`)
  - UI: dentro il blocco `activeSettingsTab === 'send'`, sezione tassonomie (righe 5391-5431)

**Interfaces:**
- Consumes: `SEND_ENTITY_TYPES`, `SEND_TAXONOMY_CATALOG`, `SendTaxonomyEntry` da `apps/frontend-admin/src/data/sendTaxonomy.ts` (Task 2).
- Produces: nessuna nuova interfaccia esterna — modifica solo UI e stato locale del componente esistente `settSendTaxonomies` (`Array<{ code: string; label: string }>`, invariato).

- [ ] **Step 1: Import del dato tassonomia**

Cercare il blocco import in cima a `apps/frontend-admin/src/App.tsx` (prima riga con `import` da un path relativo `./`) e aggiungere:

```ts
import { SEND_ENTITY_TYPES, SEND_TAXONOMY_CATALOG } from './data/sendTaxonomy';
```

- [ ] **Step 2: Nuovo state per tipologia ente e select di aggiunta**

In `apps/frontend-admin/src/App.tsx`, subito dopo la riga 613 (`const [settSendTaxonomies, setSettSendTaxonomies] = useState<Array<{ code: string; label: string }>>([]);`), aggiungere:

```ts
  const [settSendEntityType, setSettSendEntityType] = useState('');
  const [wizAddTaxonomyCode, setWizAddTaxonomyCode] = useState('');
```

- [ ] **Step 3: Caricare `send.entityType` dai settings salvati**

Individuare in `apps/frontend-admin/src/App.tsx` la riga `setSettSendSenderTaxId(String(s['send.senderTaxId'] ?? ''));` (circa riga 794) e aggiungere subito dopo:

```ts
        setSettSendEntityType(String(s['send.entityType'] ?? ''));
```

- [ ] **Step 4: Includere `send.entityType` nel payload di salvataggio**

Individuare in `apps/frontend-admin/src/App.tsx` la riga `'send.senderTaxId': settSendSenderTaxId,` (circa riga 1360, dentro l'oggetto passato a `buildSettingsPayload`) e aggiungere subito dopo:

```ts
    'send.entityType': settSendEntityType,
```

- [ ] **Step 5: UI — select tipologia ente + select di aggiunta guidata tassonomia**

Nella sezione JSX `activeSettingsTab === 'send'`, individuare il blocco (circa righe 5391-5431):

```tsx
                            <div className="mb-4">
                              <label className="form-label small fw-bold text-dark">Tassonomie SEND abilitate</label>
                              <div className="form-text small text-muted mb-2">
                                Codici a 7 caratteri dalla <a href="https://developer.pagopa.it/it/send/guides/knowledge-base/v2.5/tassonomia-send" target="_blank" rel="noreferrer">tabella ufficiale SEND</a>.
                                Termina per "P" se prevede pagamento, "N" se no — inseriscili qui manualmente, saranno selezionabili nel wizard.
                              </div>
                              {settSendTaxonomies.map((t, idx) => (
```

Sostituirlo con (aggiunta il select tipologia ente + select guidata, prima del `.map` esistente, che resta invariato):

```tsx
                            <div className="mb-3">
                              <label className="form-label small fw-bold text-dark" htmlFor="send_entity_type">Tipologia Ente</label>
                              <select
                                id="send_entity_type"
                                className="form-select form-select-sm"
                                style={{ maxWidth: 340 }}
                                value={settSendEntityType}
                                onChange={(e) => { setSettSendEntityType(e.target.value); setWizAddTaxonomyCode(''); }}
                              >
                                <option value="">-- Seleziona tipologia ente --</option>
                                {SEND_ENTITY_TYPES.map(et => (
                                  <option key={et.code} value={et.code}>{et.code} - {et.label}</option>
                                ))}
                              </select>
                              <div className="form-text small text-muted">Filtra le tassonomie ufficiali selezionabili qui sotto. Un ente ha di norma una sola tipologia.</div>
                            </div>

                            <div className="mb-4">
                              <label className="form-label small fw-bold text-dark">Tassonomie SEND abilitate</label>
                              <div className="form-text small text-muted mb-2">
                                Codici a 7 caratteri dalla <a href="https://developer.pagopa.it/it/send/guides/knowledge-base/v2.5/tassonomia-send" target="_blank" rel="noreferrer">tabella ufficiale SEND</a>.
                                Termina per "P" se prevede pagamento, "N" se no.
                              </div>
                              <div className="d-flex gap-2 mb-3">
                                <select
                                  className="form-select form-select-sm"
                                  value={wizAddTaxonomyCode}
                                  onChange={(e) => setWizAddTaxonomyCode(e.target.value)}
                                >
                                  <option value="">-- Scegli tassonomia da elenco ufficiale --</option>
                                  {SEND_TAXONOMY_CATALOG
                                    .filter(t => !settSendEntityType || t.entityType === settSendEntityType)
                                    .map(t => (
                                      <option key={t.code} value={t.code}>{t.code} — {t.title}</option>
                                    ))}
                                </select>
                                <button
                                  type="button"
                                  className="btn btn-outline-primary btn-sm text-nowrap"
                                  disabled={!wizAddTaxonomyCode}
                                  onClick={() => {
                                    const entry = SEND_TAXONOMY_CATALOG.find(t => t.code === wizAddTaxonomyCode);
                                    if (!entry) return;
                                    setSettSendTaxonomies(prev => [...prev, { code: entry.code, label: entry.title }]);
                                    setWizAddTaxonomyCode('');
                                  }}
                                >
                                  + Aggiungi da elenco
                                </button>
                              </div>
                              {wizAddTaxonomyCode && (
                                <div className="form-text small text-muted mb-2">
                                  {SEND_TAXONOMY_CATALOG.find(t => t.code === wizAddTaxonomyCode)?.description}
                                </div>
                              )}
                              <div className="form-text small text-muted mb-2">
                                Codice non in elenco? Compila il <a href="https://tassonomia-send.limesurvey.net/638616?newtest=Y&lang=it" target="_blank" rel="noreferrer">questionario ufficiale</a> e inseriscilo qui sotto a mano.
                              </div>
                              {settSendTaxonomies.map((t, idx) => (
```

- [ ] **Step 6: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 7: Verifica manuale in browser**

Con lo stack dev avviato (`docker compose up -d`), login admin/admin (LDAP mock), andare su Impostazioni → SEND:
- Selezionare "01 - Comune" in Tipologia Ente → il select "Scegli tassonomia" deve mostrare solo le 18 voci `01xxxx`.
- Selezionare una voce, cliccare "+ Aggiungi da elenco" → deve comparire una riga nella lista tassonomie con codice e label precompilati, editabile come le righe esistenti.
- Cambiare Tipologia Ente in "02" → il select di scelta deve ora mostrare solo le voci `02xxxx`.

- [ ] **Step 8: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): selettore tipologia ente e aggiunta tassonomia guidata in Impostazioni SEND"
```

---

### Task 5: Frontend — droplist gruppi PN

**Files:**
- Modify: `apps/frontend-admin/src/App.tsx`
  - Nuovo state per liste gruppi/loading/errore (vicino a riga 619, dopo `settSendTestResult`)
  - Nuova funzione `handleLoadSendGroups` (vicino a `handleTestSendConnection`, dopo riga 1461)
  - UI: dentro il blocco per-ambiente SEND (righe 5479-5489, campo "Gruppo PN")

**Interfaces:**
- Consumes: `GET admin/settings/send/:env/groups` (Task 3) tramite `apiFetch`; stato esistente `settSendTestGroup`/`setSettSendTestGroup`, `settSendProdGroup`/`setSettSendProdGroup`.
- Produces: nessuna nuova interfaccia esterna — solo UI.

- [ ] **Step 1: Nuovo state per i gruppi caricati**

In `apps/frontend-admin/src/App.tsx`, subito dopo la riga 619 (`const [settSendTestResult, ...] = useState<...>(null);`), aggiungere:

```ts
  const [settSendGroups, setSettSendGroups] = useState<Record<'test' | 'prod', Array<{ id: string; name: string; description: string }>>>({ test: [], prod: [] });
  const [settSendGroupsLoading, setSettSendGroupsLoading] = useState<'test' | 'prod' | null>(null);
  const [settSendGroupsError, setSettSendGroupsError] = useState<Record<'test' | 'prod', string | null>>({ test: null, prod: null });
```

- [ ] **Step 2: Funzione di caricamento gruppi**

In `apps/frontend-admin/src/App.tsx`, subito dopo la riga 1461 (`runPdndTest(\`/settings/send/${env}/test-connection\`, env, setSettSendTesting, setSettSendTestResult);`), aggiungere:

```ts

  const handleLoadSendGroups = async (env: 'test' | 'prod') => {
    setSettSendGroupsLoading(env);
    setSettSendGroupsError(prev => ({ ...prev, [env]: null }));
    try {
      // Salva prima le impostazioni correnti: l'endpoint legge baseUrl/apiKey dal DB.
      const saveRes = await apiFetch('/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: buildSettingsPayload() }),
      });
      if (!saveRes.ok) {
        const err = (await saveRes.json()) as { message?: string };
        setSettSendGroupsError(prev => ({ ...prev, [env]: `Errore salvataggio: ${err.message ?? saveRes.status}` }));
        return;
      }
      const res = await apiFetch(`/settings/send/${env}/groups`);
      const data = await res.json() as { groups: Array<{ id: string; name: string; description: string }>; error?: string };
      setSettSendGroups(prev => ({ ...prev, [env]: data.groups }));
      if (data.error) setSettSendGroupsError(prev => ({ ...prev, [env]: data.error! }));
    } catch (err: any) {
      if (err instanceof ApiAuthError) return;
      setSettSendGroupsError(prev => ({ ...prev, [env]: err.message || 'Errore di rete durante il caricamento dei gruppi.' }));
    } finally {
      setSettSendGroupsLoading(null);
    }
  };
```

- [ ] **Step 3: UI — sostituire il campo "Gruppo PN"**

Nella sezione JSX per-ambiente SEND, individuare il blocco (righe 5479-5489):

```tsx
                                <div className="mb-1">
                                  <label className="form-label small fw-semibold text-muted" htmlFor={`send_${e.prefix}_group`}>Gruppo PN (opzionale)</label>
                                  <input
                                    type="text"
                                    id={`send_${e.prefix}_group`}
                                    className="form-control form-control-sm"
                                    value={e.group}
                                    onChange={(ev) => e.setGroup(ev.target.value)}
                                  />
                                  <div className="form-text small text-muted">Necessario solo se l'account PN è associato a più gruppi utenti (portale self-care PN) — PN rifiuta l'invio senza specificarlo in quel caso ("Specify a group in cx_groups=..."). Lascia vuoto se l'account ha un solo gruppo.</div>
                                </div>
```

Sostituirlo con:

```tsx
                                <div className="mb-1">
                                  <label className="form-label small fw-semibold text-muted" htmlFor={`send_${e.prefix}_group`}>Gruppo PN (opzionale)</label>
                                  <div className="d-flex gap-2 mb-2">
                                    <button
                                      type="button"
                                      className="btn btn-outline-secondary btn-sm text-nowrap"
                                      disabled={settSendGroupsLoading === e.prefix}
                                      onClick={() => handleLoadSendGroups(e.prefix)}
                                    >
                                      {settSendGroupsLoading === e.prefix ? 'Carico…' : 'Carica gruppi'}
                                    </button>
                                    {settSendGroups[e.prefix].length > 0 && (
                                      <select
                                        className="form-select form-select-sm"
                                        value={e.group}
                                        onChange={(ev) => e.setGroup(ev.target.value)}
                                      >
                                        <option value="">-- Nessun gruppo --</option>
                                        {settSendGroups[e.prefix].map(g => (
                                          <option key={g.id} value={g.id}>{g.name} — {g.description}</option>
                                        ))}
                                      </select>
                                    )}
                                  </div>
                                  {settSendGroupsError[e.prefix] && (
                                    <div className="alert alert-danger mt-0 mb-2 small" style={{ wordBreak: 'break-word' }}>
                                      {settSendGroupsError[e.prefix]}
                                    </div>
                                  )}
                                  <input
                                    type="text"
                                    id={`send_${e.prefix}_group`}
                                    className="form-control form-control-sm"
                                    value={e.group}
                                    onChange={(ev) => e.setGroup(ev.target.value)}
                                  />
                                  <div className="form-text small text-muted">Necessario solo se l'account PN è associato a più gruppi utenti (portale self-care PN) — PN rifiuta l'invio senza specificarlo in quel caso ("Specify a group in cx_groups=..."). Usa "Carica gruppi" per scegliere da elenco, oppure inserisci l'id a mano. Lascia vuoto se l'account ha un solo gruppo.</div>
                                </div>
```

- [ ] **Step 4: Type-check frontend**

Run: `docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: nessun errore

- [ ] **Step 5: Verifica manuale in browser**

Con lo stack dev avviato, Impostazioni → SEND → tab Collaudo:
- Senza apiKey configurata, cliccare "Carica gruppi" → deve comparire l'alert con messaggio "API Key SEND (test) non configurata." e l'input testo restare visibile/editabile.
- Con apiKey reale di test configurata (se disponibile) o mockando la risposta lato rete, verificare che la select compaia popolata con `nome — descrizione` e che selezionando una voce si aggiorni il campo/testo sottostante.

- [ ] **Step 6: Commit**

```bash
git add apps/frontend-admin/src/App.tsx
git commit -m "feat(frontend-admin): droplist gruppi PN in Impostazioni SEND (via endpoint self-care)"
```

---

### Task 6: Verifica finale suite completa

**Files:** nessuno (solo verifica)

- [ ] **Step 1: Suite backend completa**

Run: `docker compose exec backend node_modules/.bin/jest --maxWorkers=2`
Expected: PASS, nessun fallimento nuovo rispetto alla baseline nota (nessun fallimento noto).

- [ ] **Step 2: Type-check completo backend + frontend-admin**

Run:
```bash
docker compose exec backend node_modules/.bin/tsc --noEmit
docker compose exec frontend-admin node_modules/.bin/tsc -p tsconfig.app.json --noEmit
```
Expected: nessun errore in entrambi.

- [ ] **Step 3: Aggiornare CLAUDE.md se emergono nuovi gotcha**

Se durante l'implementazione emerge un comportamento non documentato (es. host reale dell'endpoint `ext-registry-b2b` diverso da `baseUrl` usato per `/delivery/*`, riscontrato testando con credenziali vere), invocare la skill `claude-md-management:revise-claude-md` per aggiungerlo alla sezione "SEND — autenticazione reale verso PN, gotcha critico".
