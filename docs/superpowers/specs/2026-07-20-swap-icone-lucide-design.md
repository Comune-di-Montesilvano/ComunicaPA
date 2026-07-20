# Swap Icone FontAwesome → Lucide — Frontend Admin

## Problema

`apps/frontend-admin/index.html:7` carica FontAwesome 6.4.0 da CDN
esterno (`cdnjs.cloudflare.com`); `App.tsx` usa 361 occorrenze di
`<i className="fas fa-...">` (117 nomi icona distinti). Lo stile
icona-a-riga-singola di FontAweome contribuisce al look "gestionale
generico" — coerente con la direzione minimale/flat scelta per il reskin
CSS (spec sorella `2026-07-20-reskin-css-minimale-design.md`), sostituire
con Lucide (`lucide-react`): icone line-style, componenti React nativi,
tree-shakeable, nessun CDN esterno.

## Soluzione

### Dipendenza

Aggiungere `lucide-react` a `apps/frontend-admin/package.json`, seguendo
il pattern pnpm v11 già documentato in CLAUDE.md
(`pnpm install --lockfile-only --ignore-scripts` fuori dal container,
poi rebuild immagine). `lucide-react` non ha build script postinstall
noti, ma verificare comunque l'assenza di `ERR_PNPM_IGNORED_BUILDS` al
primo `docker compose build frontend-admin`.

Rimuovere il link CDN FontAwesome da `apps/frontend-admin/index.html:7`
SOLO a swap completato (non prima — altrimenti le icone non ancora
convertite spariscono).

### Import

Import nominali da `lucide-react` in cima ad `App.tsx`, non un import
`* as Icons` — mantiene tree-shaking e rende esplicito quali icone sono
in uso:

```typescript
import { Send, ArrowLeft, ArrowRight, /* ... */ } from 'lucide-react';
```

### Pattern di sostituzione — occorrenze statiche (la maggioranza)

```tsx
// Prima
<i className="fas fa-paper-plane me-2"></i>

// Dopo
<Send className="me-2" size={16} />
```

Le classi utility Bootstrap-like (`me-1`, `me-2`, `text-primary`,
`text-danger`...) restano invariate sull'elemento — sono già supportate
da `no-bootstrap-compat.css`/`app.css` e si applicano a qualunque
elemento, non solo `<i>`. `size={16}` è il default coerente con
`font-size` body corrente (`--fs-16` in `tokens.css`); dove l'icona ha
già una classe di scala (`fa-2x`, `fa-3x`, 5 e 2 occorrenze), convertire
in `size={24}`/`size={32}` rispettivamente invece della classe.

### Icone con nome dinamico — 8 punti, gestione caso per caso

Questi punti NON sono find-replace meccanico: l'icona dipende da una
condizione o da una mappa a runtime, va ristrutturato per scegliere tra
due componenti Lucide invece di due stringhe di classe.

1. **`App.tsx:130`** (`ChannelStatusBar`, tipo `StatusMeta` a riga 101) —
   `icon: string` nel tipo `StatusMeta` diventa `icon:
   React.ComponentType<{ className?: string; size?: number }>` (il tipo
   componente Lucide). Ogni entry di `CHANNEL_META` (righe 17-23),
   `SEND_STATUS_META` (righe 77-88), `POSTAL_STATUS_META` (righe
   143-157) passa da `icon: 'fa-envelope'` al componente importato,
   es. `icon: Mail`. Il fallback a riga 31/93/162 (`?? { ..., icon:
   'fa-paper-plane' }` ecc.) diventa `?? { ..., icon: Send }`. Il
   consumo a riga 130 (`<i className={`fas ${m ? m.icon :
   'fa-hourglass-half'} me-1`}></i>`) diventa:
   ```tsx
   {(() => { const Icon = m ? m.icon : Hourglass; return <Icon className="me-1" size={14} />; })()}
   ```
2. **`App.tsx:3105`, `:3399`, `:8722`** (messaggi errore/successo
   provider) — pattern identico ripetuto 3 volte: `` `fas
   ${x.error ? 'fa-triangle-exclamation' : 'fa-check-circle'}` `` diventa
   `{x.error ? <AlertTriangle /> : <CheckCircle2 />}`.
3. **`App.tsx:3204`, `:3471`** — `` `fas fa-toggle-${p.active ? 'on' :
   'off'}` `` diventa `{p.active ? <ToggleRight /> : <ToggleLeft />}`
   (stesso pattern per `c.active` a riga 3471).
4. **`App.tsx:3433`** — `` `fas ${type === 'EMAIL' ? 'fa-envelope' :
   'fa-envelope-open-text'}` `` diventa `{type === 'EMAIL' ? <Mail /> :
   <MailOpen />}`.
5. **`App.tsx:9681`** — `` `fas ${showNewSvcForm ? 'fa-minus' :
   'fa-plus'} me-1` `` diventa `{showNewSvcForm ? <Minus
   className="me-1" /> : <Plus className="me-1" />}`.
6. **`App.tsx:9945`** — `` `fas fa-sync-alt ${loadingEngines ? 'fa-spin'
   : ''}` `` diventa `<RefreshCw className={loadingEngines ?
   'icon-spin' : ''} />` — vedi sotto per `.icon-spin`.
7. **`App.tsx:9973-9980`** (`channelIcon` locale, `Record<string,
   string>`) — stesso trattamento del punto 1: tipo diventa
   `Record<string, React.ComponentType<...>>`, valori da stringa a
   componente (`EMAIL: Mail`, `PEC: MailOpen`, `APP_IO: Smartphone`,
   `SEND: Send`, `POSTAL: Mails`, `PROTOCOLLAZIONE: Stamp`). Consumo a
   riga 9991 (`<i className={`fas ${channelIcon[eng.channel] ??
   'fa-cog'}`}></i>`) diventa
   `{(() => { const Icon = channelIcon[eng.channel] ?? Settings; return <Icon />; })()}`.

### Animazione spin

FontAwesome forniva `.fa-spin` (25 occorrenze, quasi tutte su
`fa-spinner`/`fa-sync-alt` per stati di caricamento) via la propria CSS
caricata da CDN. Una volta rimosso il CDN, serve una classe propria.
`no-bootstrap-compat.css:596-598` ha già `@keyframes spin { to {
transform: rotate(360deg); } }` (usata oggi da `.spinner-border`) —
aggiungere una classe:

```css
.icon-spin {
  animation: spin 1s linear infinite;
}
```

Ogni occorrenza `fa-spinner fa-spin`/`fa-sync-alt fa-spin` diventa
`<Loader2 className="icon-spin" />` (per `fa-spinner`) o `<RefreshCw
className="icon-spin" />` (per `fa-sync-alt`, vedi punto 6 sopra per la
variante condizionale).

### Tabella di mappatura — occorrenze statiche

Nome FontAwesome → componente Lucide (import da `lucide-react`). Dove
compare più di un nome FA per lo stesso concetto (es.
`fa-magnifying-glass`/`fa-search`), la tabella riusa lo stesso
componente Lucide per entrambi — è corretto, non un errore di
trascrizione.

| FontAwesome | Lucide |
|---|---|
| fa-spinner | Loader2 |
| fa-arrow-left | ArrowLeft |
| fa-arrow-right | ArrowRight |
| fa-paper-plane | Send |
| fa-check-circle | CheckCircle2 |
| fa-triangle-exclamation | AlertTriangle |
| fa-exclamation-triangle | AlertTriangle |
| fa-trash | Trash2 |
| fa-times | X |
| fa-xmark | X |
| fa-times-circle | XCircle |
| fa-circle-xmark | XCircle |
| fa-mobile-screen | Smartphone |
| fa-mobile-alt | Smartphone |
| fa-plus | Plus |
| fa-minus | Minus |
| fa-envelope | Mail |
| fa-envelope-open-text | MailOpen |
| fa-envelope-circle-check | MailCheck |
| fa-mail-bulk | Mails |
| fa-edit | Pencil |
| fa-pen | Pencil |
| fa-check | Check |
| fa-check-double | CheckCheck |
| fa-info-circle | Info |
| fa-file-csv | FileSpreadsheet |
| fa-file-excel | FileSpreadsheet |
| fa-file-pdf | FileText |
| fa-file-lines | FileText |
| fa-file-zipper | FileArchive |
| fa-chart-pie | PieChart |
| fa-chart-line | LineChart |
| fa-chart-bar | BarChart3 |
| fa-vial | TestTube |
| fa-truck | Truck |
| fa-sync-alt | RefreshCw |
| fa-rotate | RotateCw |
| fa-rotate-right | RotateCw |
| fa-rotate-left | RotateCcw |
| fa-search | Search |
| fa-magnifying-glass | Search |
| fa-list | List |
| fa-chevron-right | ChevronRight |
| fa-chevron-left | ChevronLeft |
| fa-server | Server |
| fa-play | Play |
| fa-pause | Pause |
| fa-paperclip | Paperclip |
| fa-history | History |
| fa-clock-rotate-left | History |
| fa-download | Download |
| fa-copy | Copy |
| fa-circle-exclamation | AlertCircle |
| fa-exclamation-circle | AlertCircle |
| fa-building | Building2 |
| fa-wand-magic-sparkles | Sparkles |
| fa-magic | Wand2 |
| fa-user-check | UserCheck |
| fa-user | User |
| fa-users | Users |
| fa-user-slash | UserX |
| fa-user-circle | CircleUserRound |
| fa-upload | Upload |
| fa-stamp | Stamp |
| fa-reply | Reply |
| fa-lock | Lock |
| fa-link | Link |
| fa-keyboard | Keyboard |
| fa-inbox | Inbox |
| fa-hourglass-half | Hourglass |
| fa-circle-question | HelpCircle |
| fa-question | HelpCircle |
| fa-circle-check | CheckCircle2 |
| fa-ban | Ban |
| fa-arrow-down | ArrowDown |
| fa-thumbs-up | ThumbsUp |
| fa-tag | Tag |
| fa-tachometer-alt | Gauge |
| fa-star | Star |
| fa-sliders-h | SlidersHorizontal |
| fa-sign-out-alt | LogOut |
| fa-shield-halved | ShieldCheck |
| fa-shield-alt | Shield |
| fa-save | Save |
| fa-floppy-disk | Save |
| fa-rocket | Rocket |
| fa-ranking-star | Award |
| fa-print | Printer |
| fa-plug | Plug |
| fa-network-wired | Network |
| fa-money-check-dollar | Banknote |
| fa-map-pin | MapPin |
| fa-location-dot | MapPin |
| fa-key | Key |
| fa-id-card | IdCard |
| fa-id-badge | IdCard |
| fa-globe | Globe |
| fa-gears | Settings2 |
| fa-cogs | Settings2 |
| fa-cog | Settings |
| fa-folder-open | FolderOpen |
| fa-filter | Filter |
| fa-eye | Eye |
| fa-external-link-alt | ExternalLink |
| fa-credit-card | CreditCard |
| fa-circle-notch | Loader2 |
| fa-calendar-check | CalendarCheck |
| fa-bullhorn | Megaphone |
| fa-bars | Menu |
| fa-at | AtSign |
| fa-address-card | Contact |
| fa-address-book | BookUser |

**Verifica obbligatoria prima dell'uso**: alcuni nomi Lucide sopra
(`ShieldCheck` per `fa-shield-halved`, `IdCard`, `Contact`, `BookUser`,
`CircleUserRound`) sono la scelta più vicina per concetto ma NON sono
stati verificati contro l'elenco esportato dalla versione installata di
`lucide-react` — prima di usarli, verificare che il componente esista
davvero (`grep "export.*NomeIcona" node_modules/lucide-react/dist/lucide-react.d.ts`
dentro il container, o consultare `https://lucide.dev/icons` — solo per
verificare nomi, non per copiare codice). Se un nome non esiste, scegliere
la sostituzione visivamente più vicina disponibile e annotarla come
deviazione nel report di implementazione.

### Rimozione FontAwesome

Solo a swap completo (grep `fa-` su `App.tsx` deve tornare zero
occorrenze reali — escludendo falsi positivi come nomi variabile che
contengono "fa" per altri motivi):

- Rimuovere `apps/frontend-admin/index.html:7` (link CDN).
- Verificare che nessun altro file (`fo-components.css`, componenti
  isolati come `TemplateEditor.tsx`) referenzi ancora classi `fa-*` —
  se sì, quei punti sono fuori scope per questo grep iniziale e vanno
  aggiunti alla lista prima di rimuovere il CDN.

## Cosa NON cambia

- Nessuna modifica a `frontend-citizen` (icone eventualmente presenti lì
  sono fuori scope).
- Nessuna modifica al reskin colori/ombre (spec sorella separata).
- Dimensione icona di default 16px salvo dove la classe FA originale
  indicava una scala diversa (`fa-2x`→24px, `fa-3x`→32px, 7 occorrenze
  totali da trattare esplicitamente, non lasciare a 16px di default).

## Rischio e verifica

Rischio principale: nomi Lucide inesistenti (import che rompe la build)
— mitigato dalla verifica esplicita sopra. Rischio secondario: 361
occorrenze in un file da 11k righe aumentano la probabilità di
un'occorrenza dimenticata — la verifica finale è un grep `fa-` a zero
risultati, non un conteggio a campione. Verifica visiva browser
obbligatoria su almeno le stesse viste del reskin CSS (dashboard, wizard,
tabella campagne, impostazioni, statistiche) per controllare allineamento
verticale/dimensione delle nuove icone rispetto al testo circostante —
Lucide e FontAwesome hanno baseline/viewBox diversi, un `size` sbagliato
produce icone disallineate anche se il componente è corretto.
