# Pannello Impostazioni SEND — selettore tipologia ente + droplist gruppi PN

Data: 2026-07-14

## Contesto

Il pannello Impostazioni → SEND (`frontend-admin/src/App.tsx`, tab `activeSettingsTab === 'send'`) ha oggi due punti deboli:

1. **Tassonomie SEND abilitate**: l'operatore inserisce codice (7 caratteri) e label a mano, copiandoli dalla tabella ufficiale pagopa. Nessun aiuto, nessuna descrizione visibile in UI.
2. **Gruppo PN** (`send.{env}.group`): campo di testo libero. L'operatore deve conoscere a memoria l'id del gruppo dal portale self-care PN — nessun modo di vederne il nome/descrizione da ComunicaPA.

## Obiettivo

- Aggiungere un selettore "Tipologia Ente" (le 12 tipologie ufficiali SEND) salvato come impostazione, usato per filtrare un elenco predefinito di tassonomie (codice + descrizione ufficiale) da cui l'operatore sceglie invece di digitare a mano.
- Sostituire il campo libero "Gruppo PN" con una droplist che interroga l'API reale di PN (elenco gruppi self-care) e mostra nome + descrizione, non il solo id.

## Fonte dati taxonomy

Documento ufficiale pagopa v2.5, tassonomia SEND, snapshot verificato su:
`https://raw.githubusercontent.com/pagopa/devportal-docs-translations/a5e20810a6a3b0d6d733f955c4c3ff980e22b764/docs/3FyVXetkmOApT9WPTwPN/tassonomia-send.md`

12 tipologie ente:

| Codice | Tipologia |
|---|---|
| 01 | Comune |
| 02 | Regioni ed Enti Regionali |
| 03 | Riscossore |
| 04 | Ministeri |
| 05 | Previdenza |
| 06 | Servizio Sanitario Nazionale |
| 07 | Provincia |
| 08 | Università/ Scuola statale/ Altri Enti |
| 09 | Camera di Commercio |
| 10 | Ordine Professionale |
| 11 | Gestore di Pubblico Servizio |
| 12 | Società a Controllo Pubblico |

Tassonomie complete per tipologia (codice — titolo — descrizione), da riportare in
`apps/frontend-admin/src/data/sendTaxonomy.ts` come costante statica (nessuna chiamata di rete: dato di riferimento versionato, aggiornabile a mano se pagopa pubblica nuove voci). Il file deve includere in testa un commento con l'URL sopra e la data di verifica.

### 01 — Comune
- `010101P` — Notifiche Violazioni al Codice della Strada — Tutte le tipologie di comunicazioni/verbali/solleciti relative a violazione al CdS (divieto di sosta, autovelox, ztl etc...)
- `010102P` — Notifiche Violazioni extra CdS — Tutte le tipologie di comunicazioni relative a violazioni extra CdS (sanzioni ambientali, altre sanzioni amministrative etc...)
- `010103N` — Notifiche Violazioni al Codice della Strada — Tutte le tipologie di comunicazioni/verbali/solleciti relative a violazione al CdS (divieto di sosta, autovelox, ztl etc...)
- `010104N` — Notifiche Violazioni extra CdS — Tutte le tipologie di comunicazioni relative a violazioni extra CdS (sanzioni ambientali, altre sanzioni amministrative etc...)
- `010201P` — Notifiche Riscossione Tributi con pagamento — Tutte le tipologie di comunicazione associate ad un pagamento (es: accertamenti, solleciti etc...) relative a Tributi che l'Ente deve incassare dal cittadino/impresa (IMU, TASI, TARI, IDRICO etc...)
- `010202N` — Notifiche Riscossione Tributi senza pagamento — Tutte le tipologie di comunicazione che non prevedono un pagamento correlato (es: rettifica/annullamento dell'accertamento, atto di invito a comparire per accertamento con adesione, questionario e censimento lg. 147/2013, controllo su planimetria abitazione, revisione rendite catastali lg 336, stipula/cessazione contratto idrico, atto di messa in mora etc...) relative a Tributi che l'Ente incassa dal cittadino/impresa (IMU, TASI, TARI, IDRICO etc...)
- `010301P` — Notifiche riscossione entrate patrimoniali con pagamento — Tutte le tipologie di comunicazione associate ad un pagamento (es. notifica/sollecito rata affitti) relative a entrate patrimoniali che l'Ente incassa dal cittadino/impresa
- `010302N` — Notifiche riscossione entrate patrimoniali senza pagamento — Tutte le tipologie di comunicazione che non prevedono un pagamento correlato (es. rettifica annullamento, stipula, determinazione canone, richiesta dati reddituali, cessazione contratto etc..) relative ad entrate patrimoniali che l'Ente incassa dal cittadino/impresa
- `010401P` — Notifiche per sollecito pagamento servizi scolastici — Tutte le tipologie di comunicazione relative al sollecito di pagamento servizi scolastici (es. mense, trasporto, rette, pre post scuola etc...)
- `010401N` — Notifiche Atti Servizi Scolastici — Tutte le tipologie di comunicazione relative al sollecito di pagamento servizi scolastici (es. mense, trasporto, rette, pre post scuola etc...)
- `010501N` — Notifiche comunicazioni VL relative ad ufficio anagrafe — Tutte le tipologie di provvedimenti e notifiche emessi da Ufficio Anagrafe vs. cittadini e imprese (es. provvedimento di irreperibilità, nomina presidente/scrutatore di seggio, convocazione per giuramento cittadinanza, accesso agli atti etc...)
- `010601N` — Notifiche comunicazioni VL Ufficio Tecnico / SUAP — Tutte le tipologie di atti inviati a imprese/cittadini per procedimenti attivati c/o Ufficio Tecnico / SUAP (es. richiesta parere altri uffici, SCIA accoglimento/diniego, comunicazioni e autorizzazioni accoglimento/diniego etc...)
- `010701P` — Ordinanze Comunali con pagamento — Notifica Ordinanza ingiunzione (es. sanzioni amministrative varie)
- `010702N` — Ordinanze Comunali senza pagamento — Notifiche Ordinanze (es. ordinarie, per casi eccezionali di particolare gravità, contingibili e urgenti, etc...)
- `010801N` — Comunicazioni relative a riscossioni coattive e ingiunzioni fiscali — Notifica atti relativi a procedimenti di riscossione coattiva / ingiunzioni fiscali (es. preavviso fermo amministrativo, preavviso iscrizione ipoteca, avviso di intimazione)
- `010801P` — Comunicazioni relative a riscossioni coattive e ingiunzioni fiscali — Notifica atti relativi a procedimenti di riscossione coattiva / ingiunzioni fiscali (es. preavviso fermo amministrativo, preavviso iscrizione ipoteca, avviso di intimazione)
- `010901N` — notifica delegazioni di pagamento a tesoriere — a notificare al tesoriere i documenti richiesti da cddpp
- `011001N` — notifica atti di convocazione consiglio comunale — per notificare ai vari consiglieri comunali la convocazione del consiglio

### 02 — Regioni ed Enti Regionali
- `020101P` — Notifiche Riscossione Bollo non pagato — Tutte le comunicazione associate ad un pagamento (es: accertamenti, solleciti etc...) relative al recupero dei Bolli non pagati degli anni precedenti che l'Ente deve incassare dal cittadino/impresa.
- `020401P` — Notifiche Istanze di diniego/accettazione esenzione — Tutte le comunicazioni, di diniego, di accettazione o di carenza di documentazione, che riguardano le istanze di esenzione per il pagamento del bollo auto presentate da soggetti ex art. 3, co.3, l. 104/92, invalide, etc...
- `020402N` — Notifiche Istanze di diniego/accettazione esenzione — Tutte le comunicazioni, di diniego, di accettazione o di carenza di documentazione, che riguardano le istanze di esenzione per il pagamento del bollo auto presentate da soggetti ex art. 3, co.3, l. 104/92, invalide, etc...
- `020403N` — Notifica Tasse per Sospensione Rivenditori — Tutte le comunicazioni che riguardano il contributo da versare in relazione alla sospensione del bollo auto per rivendita

### 03 — Riscossore
- `030101P` — Notifiche Riscossione Tributi con pagamento — Tutte le tipologie di comunicazione associate ad un pagamento (es: accertamenti, solleciti etc...) relative a Tributi che l'Ente deve incassare dal cittadino/impresa (IMU, TASI, TARI, IDRICO etc...)
- `030102N` — Notifiche Riscossione Tributi senza pagamento — Tutte le tipologie di comunicazione che non prevedono un pagamento correlato relative a Tributi che l'Ente incassa dal cittadino/impresa (IMU, TASI, TARI, IDRICO etc...)
- `030201P` — Notifiche riscossione entrate patrimoniali con pagamento — Tutte le tipologie di comunicazione associate ad un pagamento (es. notifica/sollecito rata affitti, ICP, CANONE UNICO PATRIMONIALE, OCCUPAZIONE SUOLO PUBBLICO, etc...) relative a entrate patrimoniali che l'Ente incassa dal cittadino/impresa
- `030202N` — Notifiche riscossione entrate patrimoniali senza pagamento — Tutte le tipologie di comunicazione che non prevedono un pagamento correlato (es. rettifica annullamento, stipula, determinazione canone, richiesta dati reddituali, cessazione contratto etc..) relative a entrate patrimoniali che l'Ente incassa dal cittadino/impresa
- `030301P` — Comunicazioni relative a riscossioni coattive e ingiunzioni fiscali — Tutte le tipologie di comunicazioni associate ad un pagamento che prevedono la notifica di atti relativi a procedimenti di riscossione coattiva / ingiunzioni fiscali
- `030302N` — Comunicazioni relative a riscossioni coattive e ingiunzioni fiscali — Notifica atti relativi a procedimenti di riscossione coattiva / ingiunzioni fiscali
- `030401P` — Comunicazioni relative a processi amministrativi di accesso agli atti — Tutte le tipologie di comunicazioni associate ad un pagamento rispetto alla erogazione del servizio di accesso agli atti dell'Ente
- `030402N` — Comunicazioni relative a processi amministrativi di accesso agli atti — Notifiche di atti relativi a procedimenti relativi alla richiesta di accesso agli atti dell'Ente (conferma, diniego, rifiuto, etc...)
- `030501N` — Comunicazioni relative ad ufficio SUAP e Commercio — Tutte le tipologie di comunicazioni associate ad un pagamento che prevedono la notifica di atti c/o ufficio tecnico (Richiesta parere altri uffici, SCIA - Accoglimento/Diniego, Comunicazioni, Accoglimento/Diniego Autorizzazioni, etc...)
- `030601P` — Notifiche Riscossione Bollo non pagato — Tutte le comunicazione associate ad un pagamento relative al recupero dei Bolli non pagati degli anni precedenti che l'Ente deve incassare dal cittadino/impresa.

### 04 — Ministeri
- `040101N` — Notifica di concessione/diniego di cittadinanza — Notifiche di atti relativi a procedimenti inerenti a richieste di cittadinanza
- `040201N` — Comunicazione di avvio del procedimento — Costituzione in mora – Comunicazione di avvio del procedimento

### 05 — Previdenza
- `050101P` — Notifiche relative a Contributi verso l'ente previdenziale — Notifiche relative a Contributi verso l'ente previdenziale (es. Riscatti, Ricongiunzione e Rendite, Versamenti Volontari, Lavoratori Domestici)
- `050201N` — Notifiche dei Provvedimenti dei prodotti/servizi — Notifiche dei provvedimenti dei prodotti/servizi (es. Riscatti, Ricongiunzione e Rendite, Assegno di Inclusione, Supporto Formazione e Lavoro)
- `050201P` — Notifiche dei Provvedimenti dei prodotti/servizi — Notifiche dei provvedimenti dei prodotti/servizi (es. Riscatti, Ricongiunzione e Rendite, Assegno di Inclusione, Supporto Formazione e Lavoro)
- `050301N` — Notifiche dei provvedimenti di recupero indebiti — Notifiche dei provvedimenti di recupero indebiti da pensione, ammortizzatori sociali ed entrate
- `050301P` — Notifiche dei provvedimenti di recupero indebiti — Notifiche dei provvedimenti di recupero indebiti da pensione, ammortizzatori sociali ed entrate
- `050401P` — Notifiche dei provvedimenti di recupero del credito — Notifiche dei provvedimenti di recupero del credito emessi dall'Istituto Previdenziale e riscossi dall'Agenzia delle entrate-Riscossione

### 06 — Servizio Sanitario Nazionale
- `060101P` — Notifiche relative al Pagamento nei confronti della Sanità — Tutte le tipologie di notifiche che riguardano il pagamento di una tassa per usufruire del servizio sanitario pubblico
- `060201P` — Notifiche recupero crediti in seguito ad errate dichiarazioni di esenzione da reddito — Tutte le comunicazioni associate ad un pagamento, relative al recupero del ticket dovuto per le prestazioni di assistenza specialistica e/o farmaceutica fruite indebitamente

### 07 — Provincia
- `070101P` — Notifiche Violazioni al Codice della Strada — Tutte le tipologie di comunicazioni/verbali/solleciti relative a violazione al CdS in ambito provinciale (ex. autovelox, etc...)
- `070201P` — Notifiche Violazioni extra CdS — Inviare le notifiche Extra Cds per le Province
- `070202N` — Notifiche Violazioni extra CdS — Inviare le notifiche Extra Cds per le Province
- `070301P` — Ordinanze Provinciali — Inviare le notifiche Extra Cds per le Province
- `070302N` — Ordinanze Provinciali — Inviare le notifiche Extra Cds per le Province

### 08 — Università/ Scuola statale/ Altri Enti
- `080101N` — Revoca dei benefici per mancanza di requisiti — Comunicazione amministrativa di revoca per perdita dei requisiti di accesso ai benefici e richiesta di rientro delle somme percepite
- `080102N` — Remissione del credito art. 1236 codice civile — Sollecito a comunicare il Codice IBAN per l'accredito della Borsa di Studio a pena di remissione del credito in caso di inadempienza
- `080201N` — Accertamento economico-patrimoniale — Comunicazione amministrativa di avvio procedimento per accertamento di sussistenza dei requisiti che danno diritto ai benefici concessi

### 09 — Camera di Commercio
- `090101P` — Servizio di notifiche digitali per Verbali e Ordinanze — Ingiungere gli importi dovuti a seguito di sanzioni amministrative (registro imprese e di altri organi accertatori)

### 10 — Ordine Professionale
- `100101P` — Tassa Iscrizione Annua — Tutte le tipologie di comunicazioni associate al pagamento della Tassa di Iscrizione Annua che prevedono la notifica di atti relativi ai procedimenti di riscossione
- `100102N` — Tassa Iscrizione Annua — Tutte le tipologie di comunicazioni associate alla Tassa di Iscrizione Annua
- `100103P` — Notifiche relative al Pagamento nei confronti dell'Ordine — Tutte le tipologie di comunicazioni associate ad un pagamento che prevedono la notifica di atti relativi a procedimenti di riscossione (Decreti ingiuntivi, etc)
- `100104N` — Notifiche relative al Pagamento nei confronti dell'Ordine — Tutte le tipologie di comunicazioni associate ad un pagamento che prevedono la notifica di atti relativi a procedimenti di riscossione (Decreti ingiuntivi, etc)
- `100105P` — Notifiche atti amministrativi/contabili — Tutte le tipologie di comunicazioni associate ad un pagamento rispetto alla erogazione del servizio di accesso agli atti dell'Ente
- `100106N` — Notifiche atti amministrativi — Notifiche di atti relativi a procedimenti amministrativi dell'Ente (Rigetti, Cancellazioni, Sospensioni, Diffide, etc…)
- `100107N` — Avviso Morosità — Comunicazione relativa al sollecito di pagamento della Tassa di Iscrizione annua (primo, secondo e terzo avviso)

### 11 — Gestore di Pubblico Servizio
- `110101P` — Solleciti di Pagamento — Tutte le tipologie di sollecito clienti morosi

### 12 — Società a Controllo Pubblico
- `120101P` — Notifica Avviso di Pagamento — avviso di pagamento di una rata del finanziamento/contributo concesso
- `120102P` — Notifica Solleciti di Pagamento — Sollecito avviso di pagamento di una o più rate scadute del finanziamento/contributo concesso
- `120103P` — Notifica Atto di Ingiunzione — Atto di ingiunzione alla restituzione del finanziamento e/o contributo concesso qualora l'intero ammontare non sia stato restituito a seguito di revoca nei tempi stabiliti

## Architettura

### 1. Setting `send.entityType`

- `apps/backend/src/settings/settings.registry.ts`: nuova chiave `'send.entityType': { type: 'string', default: '' }` (non secret, non bootstrapOnly — configurabile da UI come le altre chiavi SEND).
- Frontend: nuovo select "Tipologia Ente" nel tab SEND, sopra la sezione tassonomie, con le 12 opzioni + opzione vuota "-- Nessuna --". Stato `settSendEntityType`, letto/scritto come gli altri campi SEND esistenti (pattern identico a `settSendSenderTaxId`).

### 2. Dato statico tassonomie

- Nuovo file `apps/frontend-admin/src/data/sendTaxonomy.ts`:
  ```ts
  export interface SendTaxonomyEntry { code: string; title: string; description: string; entityType: string }
  export const SEND_ENTITY_TYPES: { code: string; label: string }[] = [ /* 12 voci */ ];
  export const SEND_TAXONOMY_CATALOG: SendTaxonomyEntry[] = [ /* tutte le voci sopra */ ];
  ```
- Nessuna chiamata di rete, nessun endpoint backend nuovo per questo: è un dato di riferimento statico versionato col codice, come già avviene per altre tabelle di lookup nel frontend.

### 3. UI "Aggiungi tassonomia"

- Sezione "Tassonomie SEND abilitate" (`App.tsx` ~riga 5391): sotto il testo esplicativo, aggiungere un secondo controllo:
  - `<select>` che elenca `SEND_TAXONOMY_CATALOG.filter(t => t.entityType === settSendEntityType)` (se `settSendEntityType` vuoto, elenca tutte le 12 tipologie raggruppate per `<optgroup>`), mostrando `code — title`.
  - Bottone "+ Aggiungi da tassonomia" che fa `push` di `{ code, label: title }` nell'array `settSendTaxonomies` esistente (stesso stato, stessa struttura dati — nessuna migrazione).
  - Il blocco "+ Aggiungi tassonomia" manuale (righe libere code/label) resta invariato sotto, per codici non ancora censiti nella tabella locale (l'operatore compila il questionario pagopa e inserisce a mano).
- Nessun cambiamento alla struttura dati salvata (`send.enabledTaxonomyCodes` resta `{code, label}[]` come oggi) — cambia solo *come* l'operatore la popola.

### 4. Endpoint backend per elenco gruppi PN

- Nuova route in `apps/backend/src/settings/settings.controller.ts` (stesso controller che già espone `handleTestSendConnection`/test PDND): `GET admin/settings/send/groups?env=test|prod`.
- Service (nuovo metodo su `SettingsService` o service dedicato minimale): legge `send.{env}.baseUrl` e `send.{env}.apiKey` da `AppSettingsService`, chiama:
  ```
  GET {baseUrl}/ext-registry-b2b/pa/v1/groups?statusFilter=ACTIVE
  Header: x-api-key: <apiKey>
  ```
  (solo `x-api-key`, confermato da spec ufficiale `pn-external-registries` — a differenza delle route `/delivery/*` questo endpoint NON richiede voucher PDND).
- Risposta upstream: `[{ id, name, description, status }]` → il backend la inoltra as-is (già filtrata ACTIVE) al frontend.
- Errori upstream (baseUrl/apiKey non configurati, 401/403/network): risposta 200 con `{ groups: [], error: '<messaggio leggibile>' }` — pattern esistente nel repo per non far sparire il messaggio dietro al reverse proxy esterno (vedi CLAUDE.md, sezione reverse proxy).

### 5. UI campo "Gruppo PN"

- Sostituire l'input testo con:
  - Bottone "Carica gruppi" (pattern identico a "Test connessione", stesso `fieldset` per-ambiente) che chiama il nuovo endpoint per l'ambiente corrente (`test`/`prod`), popola uno stato locale `groupsList[env]`.
  - Se `groupsList[env]` non vuoto: `<select>` con opzioni `name — description` (value = `id`), `onChange` scrive nel campo `send.{env}.group` esistente (stesso stato `settSendTestGroup`/`settSendProdGroup`).
  - L'input testo libero resta visibile sotto la select come fallback, sempre editabile — copre il caso di errore nella chiamata o ente senza feature gruppi attiva. Se l'id già salvato non è tra quelli caricati (es. gruppo poi rinominato/rimosso), l'input testo mostra comunque il valore corrente.
- Nessuna persistenza aggiuntiva: `send.{env}.group` resta l'unico setting, la select è solo un modo più comodo di scriverci dentro.

## Error handling

- Fetch gruppi fallita (rete, 401/403, baseUrl/apiKey mancanti): messaggio inline nel pannello (stesso stile `alert-danger` di `settSendTestResult`), la select resta vuota/nascosta, l'input testo resta utilizzabile.
- Fetch tassonomie: nessuna chiamata di rete, quindi nessun error handling da gestire (dato statico locale).

## Testing

- Backend: test unitario nuovo endpoint groups (mock fetch upstream: caso 200 con lista, caso errore rete, caso apiKey/baseUrl mancanti) — pattern analogo a `handleTestSendConnection` esistente in `settings.controller.spec.ts`.
- Frontend: verifica manuale in browser (dev, LDAP mock) — nessun test automatico esistente sul componente App.tsx per questa sezione, si segue la convenzione attuale del repo (nessun test frontend per la UI impostazioni).
- Verifica end-to-end reale dell'endpoint gruppi (chiamata a PN vera) rimandata a quando si testerà su un ambiente UAT con apiKey valida — stesso vincolo già presente per "Test connessione" SEND (richiede credenziali reali).

## Fuori scope

- Non si modifica la logica di invio (`send-dispatch.service.ts`): il payload continua a leggere `send.{env}.group` come stringa, indifferente al fatto che sia stata scritta a mano o scelta da droplist.
- Non si aggiungono le tassonomie delle altre 11 tipologie ente al wizard di default: restano comunque disponibili come dato, selezionabili cambiando `send.entityType`, per enti che in futuro gestissero più tipologie (fuori scope attuale: un'istanza ComunicaPA serve un solo ente).
