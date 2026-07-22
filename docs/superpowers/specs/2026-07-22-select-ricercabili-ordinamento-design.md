# Select ricercabili + ordinamento default-first (mittenti, servizi, tassonomie SEND)

Data: 2026-07-22

## Obiettivo

Per tutte le select che elencano mittenti PEC/EMAIL, servizi App IO e tassonomie
SEND: mostrare sempre il predefinito per primo, poi il resto in ordine
alfabetico, e rendere la select ricercabile (digitando si filtra l'elenco).
Per le tassonomie SEND, cambiare anche il formato label da `"CODICE — Descrizione"`
a `"Descrizione - CODICE"`, e introdurre un doppio default indipendente
(uno per tassonomie "con pagamento", suffisso `P`, uno per "senza pagamento",
suffisso `N`).

## Componente riusabile — `SearchableSelect`

Nuovo file `apps/frontend-admin/src/components/SearchableSelect.tsx`.
Combobox custom (input filtro + dropdown), nessuna nuova dipendenza
(niente `react-select`, evita il workaround pnpm v11 per nuovi pacchetti —
vedi CLAUDE.md).

```ts
interface SearchableSelectOption {
  value: string;
  label: string;
  isDefault?: boolean;
}

interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}
```

**Ordinamento**: il componente ordina internamente `options` — predefinito
(`isDefault: true`) sempre primo, resto per `label.localeCompare(other.label, 'it')`.
Nessun sort duplicato nei punti di chiamata: i chiamanti passano gli
`options` grezzi (con `isDefault` già valorizzato dove applicabile), il
componente fa l'unica fonte di ordinamento.

**Ricerca**: input testo che filtra `options` per substring case-insensitive
sul `label` (contains, non solo prefix).

**UX**: nessuna riga fittizia "-- Seleziona --" nell'elenco. Quando
`value === ''` l'input mostra `placeholder` in grigio. Quando valorizzato,
un bottone "×" pulisce la selezione (torna a `value: ''`). Dropdown si apre
al focus/click sull'input, si chiude su click esterno o `Escape`. Frecce
su/giù muovono l'evidenziazione, `Enter` seleziona la voce evidenziata.
Nessuna voce corrispondente → riga statica "Nessun risultato" non cliccabile.

**Styling**: classi Bootstrap (`form-control`/`form-select`) per restare
visivamente indistinguibile dalle select native circostanti; `className`
passato dal chiamante per `form-select-sm` dove serve (parità con gli
usi attuali `form-select` vs `form-select-sm`).

## Mittenti PEC/EMAIL — sostituzione `<select>` nativo

`isDefault` già esiste su `MailConfigItem` (feature precedente). Sostituire
`<select>` con `SearchableSelect` in 3 punti (`apps/frontend-admin/src/App.tsx`,
righe indicative — vanno confermate al momento dell'implementazione, il file
cambia numerazione a ogni edit precedente):
- ~6784 — select "Server di Invio / Mittente" (wizard step avanzato)
- ~7384 — stesso select, wizard step compatto
- ~7409 — select "Mittente PEC di riserva (verifica INAD)"

`options` costruito da `mailConfigs.filter(c => c.type === wizChannel && c.active).map(c => ({ value: c.id, label: \`${c.name} (${c.fromAddress})\`, isDefault: c.isDefault }))`
— il badge `(Predefinito)` che oggi appare nella label testuale
dell'`<option>` viene rimosso dal testo (l'ordinamento primo-in-lista lo
rende già evidente; se si vuole mantenere un segnale visivo, il componente
può opzionalmente prefissare `★ ` alla label quando `isDefault`, valutare
in fase di implementazione senza bloccare lo spec).

## Servizi App IO — sostituzione `<select>` nativo

`isDefault` già esiste su `IoService` (feature App IO pre-esistente).
Sostituire in 5 punti:
- ~6810 — "Servizio App IO Associato" (wizard step avanzato)
- ~7053 — servizio App IO in co-consegna "parallel" (wizard step compatto)
- ~7449 — "Co-consegna su App IO" (card condivisa EMAIL/PEC/POSTAL)
- ~7466 — "Servizio App IO Associato", ramo `wizChannel==='APP_IO'` (step compatto)
- ~9482 — pagina "Verifica massiva App IO" (fuori dal wizard campagne, stesso
  trattamento per coerenza)

`options` da `ioServices.map(s => ({ value: s.id, label: s.nome, isDefault: s.isDefault }))`.

## Tassonomie SEND — doppio default + nuovo formato label

**Dati**: `settSendTaxonomies` (App.tsx:1426) passa da
`Array<{ code: string; label: string }>` a
`Array<{ code: string; label: string; isDefault?: boolean }>`. Nessuna
migration DB: il valore resta un blob JSON in `app_settings` chiave
`send.enabledTaxonomyCodes` (già `type: 'string'` in
`settings.registry.ts:59`, la stringa JSON semplicemente guadagna un campo
in più per elemento — retrocompatibile, righe esistenti senza `isDefault`
si comportano come `isDefault: false`/`undefined`).

**Doppio default indipendente**: il discriminante pagamento è già il
suffisso del `code` (`P`/`N`, verificato in `sendTaxonomy.ts` — nessun
campo nuovo necessario). "Predefinita" è quindi sempre relativa al proprio
gruppo P/N: impostare il default su una riga con `code` che termina `P`
azzera `isDefault` sulle altre righe che terminano `P` (non tocca quelle
che terminano `N`), e viceversa.

**UI Impostazioni → SEND** (App.tsx, blocco righe ~10820-10846, lista
`settSendTaxonomies.map(...)`): ogni riga (oggi due `<input>` codice+label
più bottone "Rimuovi") guadagna un bottone "Imposta come predefinita"
(icona stella, stesso pattern visivo di mail-configs/io-services) —
`onClick` locale via `setSettSendTaxonomies` che azzera `isDefault` sulle
righe con lo stesso suffisso `P`/`N` del `code` corrente e lo imposta a
`true` sulla riga cliccata. Nessuna chiamata API dedicata: fa parte dello
stesso stato React salvato in blocco dal bottone globale "Salva
Impostazioni" esistente (`send.enabledTaxonomyCodes: JSON.stringify(settSendTaxonomies)`,
riga 2601), nessuna modifica a quel punto di salvataggio.

**Select wizard campagne** (righe ~6830-6841, ~7284-7297): sostituire con
`SearchableSelect`. `options` da
`settSendTaxonomies.filter(t => t.code.endsWith(wizPaymentEnabled ? 'P' : 'N')).map(t => ({ value: t.code, label: \`${t.label} - ${t.code}\`, isDefault: t.isDefault }))`
— il filtro pagamento esistente resta invariato, cambia solo label
(ordine invertito: descrizione poi codice) e il componente usato.

**Select "Scegli tassonomia da elenco ufficiale"** (Impostazioni, riga
~10786-10796, sul catalogo statico completo `SEND_TAXONOMY_CATALOG`, NON
sul sottoinsieme abilitato): sostituire con `SearchableSelect`. Qui non
esiste `isDefault` (è la lista sorgente da cui aggiungere, non quella da
cui il wizard sceglie per l'invio) — solo alfabetico su `title`.
`options` da
`SEND_TAXONOMY_CATALOG.filter(t => !settSendEntityType || t.entityType === settSendEntityType).map(t => ({ value: t.code, label: \`${t.title} - ${t.code}\` }))`.

## Fuori scope

- Select "Tipologia Ente" (`SEND_ENTITY_TYPES`, riga ~10764-10775): elenco
  minuscolo (poche voci fisse), nessun concetto di default, resta `<select>`
  nativo.
- Select POSTAL provider: non esiste nel wizard (provider scelto
  automaticamente, unico attivo) — nessuna azione.
- Nessuna modifica al meccanismo di persistenza `app_settings` oltre al
  contenuto del blob JSON già esistente — nessuna migration backend.
