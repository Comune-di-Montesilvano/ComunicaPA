# Reskin CSS Minimale/Flat — Frontend Admin

## Problema

L'admin (`apps/frontend-admin`) usa tre fogli di stile che insieme
producono un look "gestionale Bootstrap generico":

- `tokens.css` — sistema di design civico completo e già pronto (viola/oro
  dello stemma comunale, navy istituzionale Bootstrap Italia, scala
  tipografica, spaziature, radii, ombre) ma **quasi inutilizzato** dal
  resto dell'admin.
- `no-bootstrap-compat.css` (916 righe) — layer di compatibilità scritto
  dopo la rimozione della vera libreria Bootstrap, che however **replica
  i default Bootstrap standard**: `--primary: #0066cc` (blu Bootstrap
  generico, non il navy/viola dello stemma), radii/ombre da libreria
  generica.
- `backoffice-shell.css` (1928 righe) — shell sidebar/topbar con propria
  variabile `--bo-accent: #0066cc` (stesso blu generico, hardcoded,
  scollegato da `tokens.css`), sidebar navy scuro (`#0f1f36`, ragionevole
  ma arbitrario) con ombre/decorazioni tipiche di un template acquistato.

Risultato: ogni componente (`btn-primary`, `card`, sidebar, badge...) usa
lo stesso blu/ombra/radius di qualunque altro pannello admin Bootstrap
in circolazione — la causa concreta del "sembra copiato da altri
gestionali".

## Soluzione

Riskin **solo CSS**: nessuna riga di `App.tsx` toccata in questo spec
(a parte pochi punti isolati elencati sotto, dove il solo CSS non basta).
Direzione: **minimale/pulito, quasi flat** — palette ridotta, bordi netti
al posto di ombre pesanti, molto whitespace, tipografia come elemento
dominante (i token in `tokens.css` già supportano questo: scala
tipografica 1.125, spaziatura 8px-based).

### `tokens.css` — un solo aggiunta

Decisione confermata: il colore primario passa dal blu istituzionale
`--bi-primary` (`#0066CC`, uguale al valore oggi hardcoded altrove — non
avrebbe cambiato nulla) al navy scuro `--bi-navy` (`#003366`, stessa
famiglia Bootstrap Italia/conforme AGID, ma visivamente distinto dal blu
generico che usa qualunque altro gestionale Bootstrap). Manca un hover
per il navy (oggi esiste solo `--bi-primary-h: #004080` per il blu) —
aggiungere subito dopo `--bi-navy: #003366;` (riga 58):

```css
--bi-navy-h: #002448;   /* hover, piu' scuro di --bi-navy */
```

Poi ripuntare il ruolo semantico (riga 104):

```css
--brand-primary: var(--bi-navy);   /* era var(--bi-primary), blu generico */
```

### `no-bootstrap-compat.css`

Sostituire le variabili hardcoded con riferimenti a `tokens.css`:

```css
--primary: var(--brand-primary);   /* ora risolve a --bi-navy, non piu' blu generico */
--danger:  var(--ms-danger);
--success: var(--ms-success);
--warning: var(--ms-warning);
--info:    var(--ms-info);
--border-color: var(--border-1);
--text-muted:   var(--fg-3);
--radius-sm: var(--r-sm);
--radius-md: var(--r-sm);          /* flat: radius piccolo anche per "md",
                                       non il default Bootstrap arrotondato */
```

Ombre: dove il file usa `box-shadow` per bottoni/card (cercare tutte le
occorrenze `box-shadow` nel file), sostituire con `var(--shadow-1)` al
massimo — mai `--shadow-3` o superiore, coerente con "quasi flat". Bordi
`1px solid var(--border-1)` al posto di ombre dove possibile (card,
input, dropdown).

Le variabili `--bs-*` (compatibilità TomSelect, righe 23-33 del file)
restano invariate — servono a una libreria di terze parti, non fanno
parte dell'identità visiva propria.

### `backoffice-shell.css`

```css
--bo-accent:       var(--brand-primary);  /* era #0066cc hardcoded */
--bo-accent-hover: var(--bi-primary-h);
--bo-radius-sm: var(--r-sm);
--bo-radius:    var(--r-sm);   /* era 6px, flat: stesso valore di sm */
--bo-radius-lg: var(--r-md);   /* era 10px, ridotto */
```

Sidebar (`--bo-sidebar-bg: #0f1f36`, `--bo-sidebar-active: #16365f`,
`--bo-sidebar-accent: #4fa3ff`): il fondo scuro attuale è già
concettualmente vicino al navy scelto (`--bi-navy #003366`) — sostituire
con `var(--bi-navy)` per `--bo-sidebar-bg` (era `#0f1f36`, leggermente
diverso ma stesso registro cromatico), `var(--bi-navy-h)` per
`--bo-sidebar-active` (stato attivo più scuro), e `var(--bi-primary)`
(blu istituzionale più chiaro, non il navy) per `--bo-sidebar-accent` —
mantiene un accento leggibile su fondo scuro senza introdurre un terzo
colore scollegato.

Ricerca ombre: ogni `box-shadow` con blur >8px o multipli layer va
ridotta a `var(--shadow-1)` (bordo sottile + ombra minima) — grep
`box-shadow` nel file prima di modificare, elencare ogni occorrenza,
decidere caso per caso se l'ombra serve a comunicare elevazione
(es. dropdown aperto, modal) o è pura decorazione (es. card statiche,
dove va rimossa/ridotta).

### `app.css`

337 righe, utility custom dell'admin (menzionato in CLAUDE.md). Audit
delle stesse categorie (colori hardcoded, radius, ombre) con lo stesso
criterio sopra — nessuna riga da toccare a priori, dipende da cosa
emerge dal grep.

### Interventi mirati su `App.tsx` (fuori dal "solo CSS")

Solo dove il CSS non può bastare da solo:

- **Bottone primario invio singolo** (era riga ~5659, oggi spostato dopo
  le modifiche del sub-progetto 1): `style={{ backgroundColor:
  'var(--bi-primary)', border: 'none' }}` inline — va cambiato in
  `var(--brand-primary)` per coerenza (o rimosso lo style inline se la
  classe `btn-primary` dopo il reskin CSS già risolve allo stesso
  colore — verificare prima di lasciare lo style inline ridondante).
- Qualunque altro `style={{ ... 'var(--bi-primary)' ... }}` o colore hex
  inline trovato via grep (`grep -n "backgroundColor.*#\|color.*#[0-9a-f]\{6\}" App.tsx`)
  va allineato allo stesso criterio: usare i token semantici
  (`--brand-primary`, `--ms-danger`, ecc.) invece di valori hardcoded o
  del vecchio `--bi-primary` non aggiornato.

## Cosa NON cambia

- Nessuna libreria nuova, nessuna dipendenza.
- Nessuna modifica a `App.tsx` oltre ai punti espliciti sopra (grep-driven,
  non riscrittura).
- Nessuna modifica a `frontend-citizen` (fuori scope, ha già una propria
  identità coerente con `tokens.css` secondo CLAUDE.md).
- Nessuna modifica alle icone (sub-progetto separato, vedi
  `2026-07-20-swap-icone-lucide-design.md`).

## Rischio e verifica

Rischio strutturale basso (solo CSS, variabili). Rischio percettivo: un
cambio di questa portata su TUTTE le pagine richiede verifica visiva
manuale (screenshot/browser) su un campione di viste rappresentative
(dashboard, wizard step1 e step6, tabella campagne, impostazioni,
statistiche) per assicurarsi che nessun contrasto testo/sfondo diventi
illeggibile dopo il cambio colore primario (da blu a navy/viola scuro —
verificare specificamente testo bianco su bottoni/badge che usano
`--primary`/`--bo-accent`).
