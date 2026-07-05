# Multi-allegato per destinatario — Design

**Data:** 2026-07-06
**Contesto:** Oggi ogni destinatario può avere al massimo UN allegato PDF personalizzato (`campaign.channelConfig.allegatoKey` → nome colonna CSV mappata, placeholder `%allegato1%` nel template). L'operatore ha chiesto di poter mappare più colonne CSV come allegati distinti (es. "Tassa", "Ruolo") e di avere un blocco standard nel template che li elenchi tutti automaticamente, invece di dover comporre a mano un link per allegato.

## Scope

Dentro questo piano:
- Wizard: selezione multipla di colonne CSV come allegati, con etichetta scritta a mano per ciascuna.
- Placeholder individuali `%allegato1%`...`%allegatoN%` (uno per colonna mappata, in ordine di selezione).
- Nuova macro `%elenco_allegati%` che si espande in un blocco standard con tutti gli allegati del destinatario.
- Download sicuro per N file distinti per lo stesso destinatario (non solo 1).
- Retention/cleanup estesi a N file per destinatario.

Fuori scope (deferito ad altre spec/piani):
- Redesign del template App IO (spec separata, già concordata) — qui tocchiamo `processTemplate` solo per aggiungere il parametro `format`, non ridisegniamo l'editor App IO.
- Supporto allegati sul canale SEND — oggi non esiste (`SendStrategy` non usa `processTemplate`), resta un gap pre-esistente non affrontato qui.
- Canale POSTAL — usa un PDF stampato generato server-side (`AttachmentService.generatePdfBuffer` fallback), non un allegato "mappato" dal CSV: non toccato.

## Modello dati

`campaign.channelConfig` è `jsonb`, nessuna migration DB necessaria. Sostituiamo la chiave singola con un array:

```ts
channelConfig.attachments: Array<{ key: string; label: string }>
```

- `key`: nome della colonna CSV mappata (chiave in `recipient.extraData`), stesso significato dell'attuale `allegatoKey`.
- `label`: testo libero scritto dall'operatore nel wizard (es. "Avviso TARI", "Ruolo esattoriale"). Non derivato dall'header CSV (spesso assente o generico tipo "Colonna 16").
- Ordine dell'array = ordine di `%allegato1%`, `%allegato2%`, ...: il primo elemento è `%allegato1%`, ecc.

**Retrocompatibilità:** campagne esistenti hanno `channelConfig.allegatoKey` (stringa singola, nessun `attachments`). Ovunque il codice legga `attachments`, se assente si ricostruisce al volo: `attachments = channelConfig.allegatoKey ? [{ key: channelConfig.allegatoKey, label: 'Allegato 1' }] : []`. Nessuna migrazione dati necessaria, nessuna riscrittura di campagne vecchie.

## Wizard (Passo 3 — Mappatura & Validazione)

Il singolo dropdown "Campo Speciale Allegato" viene sostituito da un blocco "Colonne Allegato":
- Multi-select (checkbox list) delle colonne CSV rilevate (`wizCsvHeaders`), stesso sample-value hint già introdotto nel fix precedente (`wizColumnOptionLabel`) per riconoscere le colonne anche senza header.
- Per ogni colonna selezionata, compare sotto un campo testo libero "Etichetta per questo allegato" (obbligatorio se la colonna è selezionata, altrimenti non validabile per il blocco `%elenco_allegati%`).
- Stato wizard: `wizAttachments: Array<{ key: string; label: string }>` sostituisce l'attuale `wizMapping.allegato1: string`.
- Riordino: l'ordine di selezione nel multi-select determina l'ordine `%allegato1%`, `%allegato2%`... (nessun drag-and-drop nel primo taglio — YAGNI, si può aggiungere dopo se richiesto).

## Placeholder nel template

`processTemplate` (in `apps/backend/src/channels/template.helper.ts`) viene esteso:

1. **Placeholder individuali:** oggi sostituisce solo `%allegato1%` con un unico link. Diventa un loop su `attachments[]`: `%allegato1%` → link al primo, `%allegato2%` → link al secondo, ecc. Ogni placeholder non mappato (es. `%allegato3%` in un template ma solo 2 allegati configurati) resta non sostituito (comportamento invariato: placeholder sconosciuti restano testo letterale, coerente con la regex `%key%` generica esistente).

2. **Macro `%elenco_allegati%`:** si espande in un blocco con etichetta+link per ogni allegato configurato per quel destinatario. Formato dipende dal nuovo parametro `format`:
   - `format: 'html'` (default, usato da EMAIL/PEC): tabella 2 colonne (etichetta | link "Scarica"), una riga per allegato.
   - `format: 'markdown'` (usato da App IO in `sendAppIoMessage`): elenco puntato Markdown, una riga per allegato: `- **Etichetta**: [Scarica](url)`.
   - Nessun allegato configurato per il destinatario → macro si espande in stringa vuota (nessuna tabella/elenco vuoto visibile).

Firma aggiornata:
```ts
export function processTemplate(
  bodyTemplate: string,
  recipient: Recipient,
  publicApiUrl: string,
  downloadLinkSecret: string,
  expiresAtUnix: number,
  format: 'html' | 'markdown' = 'html',
): string
```

## TemplateEditor (frontend)

Il pulsante toolbar placeholder guadagna una nuova voce "Elenco Allegati" (token `%elenco_allegati%`), oltre ai placeholder individuali `%allegato1%`...`%allegatoN%` generati dinamicamente in base a `wizAttachments.length` (stesso pattern già usato per le colonne CSV extra, vedi `App.tsx` righe ~3200-3207).

## Download sicuro multi-file

Oggi: `GET /public/download/:recipientId?exp&sig`, firma HMAC su `recipientId:exp`, un solo file per recipient (`AttachmentService.generatePdfBuffer`).

Nuovo: `GET /public/download/:recipientId/:index?exp&sig`, firma HMAC su `recipientId:index:exp`. `index` è l'indice (0-based) nell'array `attachments[]` di quella campagna. Includere `index` nella firma impedisce che un link valido per l'allegato 0 venga riusato per leggere l'allegato 1 cambiando solo l'URL.

```ts
// download-link.util.ts
function computeSignature(recipientId: string, index: number, expiresAtUnix: number, secret: string): string {
  return createHmac('sha256', secret).update(`${recipientId}:${index}:${expiresAtUnix}`).digest('hex');
}
export function signDownloadLink(recipientId: string, index: number, expiresAtUnix: number, secret: string): string
export function verifyDownloadLink(recipientId: string, index: number, expiresAtUnix: number, signature: string, secret: string): boolean
```

**Retrocompatibilità firma:** i link già inviati prima di questo cambiamento (senza `index` nel path, firmati su `recipientId:exp` senza indice) smetteranno di validare con la nuova funzione `verifyDownloadLink`. Dato che i link di download hanno una scadenza (`retention.maxDays`, default 90gg) e sono generati SOLO al momento dell'invio (mai rigenerati per notifiche già spedite), l'impatto è: destinatari che hanno ricevuto un'email/PEC PRIMA del deploy di questa modifica e cliccano il link DOPO il deploy troveranno un errore "Link non valido" invece di "Link scaduto". Non c'è modo di evitarlo senza mantenere doppia logica di verifica a tempo indeterminato — si accetta il breaking change, da comunicare come nota di rilascio (non da gestire in questo piano con retrocompatibilità dual-scheme, sarebbe over-engineering per un gap che si chiude da solo entro il periodo di retention).

`AttachmentService.generatePdfBuffer(recipient)` diventa `generatePdfBuffer(recipient, index)`: risolve `attachments[index]` invece del singolo `allegatoKey`; se `index` fuori range o nessun file trovato, fallback al PDF generato automaticamente (comportamento invariato per il caso "nessun allegato personalizzato").

`resolveCustomAttachmentFilename` diventa `resolveCustomAttachmentFilename(recipient, index)`, legge `channelConfig.attachments[index].key` (con fallback alla logica retrocompatibile `allegatoKey` solo per `index === 0`).

## Retention cleanup

`RetentionCleanupService` oggi cancella UN file per recipient scaduto (via `resolveCustomAttachmentFilename`). Va esteso a ciclare su tutti gli `attachments[]` della campagna e cancellare ogni file risolto per quel recipient, non solo il primo.

## Testing

- `template.helper.spec.ts`: nuovi casi per placeholder multipli `%allegato1%`/`%allegato2%`, macro `%elenco_allegati%` in entrambi i format (html/markdown), caso zero allegati.
- `download-link.util.spec.ts` (se non esiste, crearlo): firma/verifica con index, verifica che un indice diverso invalidi la firma.
- `attachment.service.spec.ts` / equivalente: risoluzione filename per indice, fallback su indice fuori range.
- `retention-cleanup.service.spec.ts`: estendere i case esistenti (righe 16, 65-67, 87) al nuovo formato `attachments[]` con più file da cancellare.
- Frontend: nessun test automatico (frontend-admin non ha test runner) — verifica manuale via browser (wizard multi-select + editor placeholder) come da CLAUDE.md.

## Domande aperte per il piano

Nessuna: le decisioni di design (multi-select dedicato, etichetta manuale, macro auto-generata, formato tabella HTML/markdown) sono state confermate dall'utente durante il brainstorming.
