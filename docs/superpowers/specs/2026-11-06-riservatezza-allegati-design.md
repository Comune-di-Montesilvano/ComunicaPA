# Riservatezza allegati — solo creatore, admin e firmatario indicato

Data: 2026-11-06

## Perché

Il 2026-11-06 un operatore ha preparato un invio SEND riservato destinato a un
dipendente dell'ente. Oggi qualunque operatore autenticato (ruolo `user` o
`admin`) può aprire il contenuto degli allegati di qualunque campagna: il
controllo di ownership esiste solo sulle azioni (`launch`, `cancel`, `remove`,
`launchTestSend`), mai sulla lettura. Un documento riservato su un collega
è quindi leggibile da tutti gli uffici.

## Obiettivo

Il **contenuto** degli allegati di una campagna è leggibile solo da:

1. chi ha creato la campagna (`campaign.createdBy`);
2. gli operatori con ruolo `admin`;
3. l'**utente autorizzato alla firma** indicato sulla campagna, se presente.

La regola vale per tutte le campagne, senza flag "riservato".

## Bozze invisibili (decisione utente, aggiunta dopo la prima stesura)

Una campagna in stato `DRAFT` è **interamente** invisibile a chiunque non sia
admin, creatore o firmatario indicato (stessa regola degli allegati; il
firmatario esiste solo per SEND, per gli altri canali restano creatore e admin).

- **Elenco campagne** (`findAll`, dashboard, aggregazione gruppi multicanale
  `aggregateCampaignGroups`): le bozze altrui non compaiono. Un gruppo con membri
  misti mostra solo i membri visibili (scelta di Claude).
- **Ogni endpoint con `:id` campagna** (dettaglio, destinatari, stats, report,
  export, firma, verifica firma, poste-tracking, allegati, ecc. — controller
  `campaigns`, `signed-attachments`, `signature-verification`, `remote-sign`,
  `poste-tracking` e qualunque altro con `:id` di campagna): bozza non visibile →
  **404** come se non esistesse (scelta di Claude: non rivelare l'esistenza).
  Implementazione consigliata: un controllo centrale (guard/helper unico)
  applicato a tutte le route con `:id` campagna, non endpoint per endpoint; il
  builder verifica con grep che nessuna route resti scoperta.
- **Ricerca notifiche**: i destinatari esistono già in bozza (sync wizard) e i
  test di invio creano tentativi → risultati e dettaglio di destinatari di bozze
  non visibili vanno esclusi (lista filtrata, dettaglio 404).
- **Conteggi aggregati globali** (statistiche dashboard senza nomi né dettagli):
  possono includere le bozze, nessuna informazione riservata (scelta di Claude).
- **Dopo il lancio** (stato ≠ `DRAFT`) la campagna torna visibile a tutti come
  oggi; restano protetti solo gli allegati. Una campagna riportata a `DRAFT`
  (es. lancio fallito) torna invisibile.
- Test: altro `user` non vede bozza in elenco, 404 su dettaglio/destinatari/
  stats/ricerca notifiche; creatore/admin/firmatario la vedono; dopo il lancio
  la vede anche l'altro `user` (allegati esclusi).

## Non-obiettivi

- **Non** si filtra la visibilità di campagne **lanciate**, destinatari, report,
  export, ricerca notifiche, statistiche: restano visibili a tutti gli operatori.
  Decisione esplicita dell'utente ("basta oscurare l'allegato"); unica eccezione
  le bozze (sezione sopra).
- **Nomi file** degli allegati restano visibili (si oscura il contenuto).
- **Atti opponibili SEND** (`notifications-search/:recipientId/send-legal-facts/download`)
  restano visibili: sono ricevute PN, non il documento.
- Portale cittadino (`citizen/notifications/:id/attachment/:index`,
  `citizen/notifications/:id/download`) e link pubblico (`public/download/*`):
  invariati, il destinatario deve continuare a scaricare.
- API esterna (`external/v2/*`): fuori perimetro, client macchina.
- Più firmatari per campagna: no, uno solo.

## Anti-obiettivi (fallimento anche se "funziona")

- Nascondere solo il bottone nel frontend lasciando l'endpoint aperto.
- Rompere il flusso reale di firma: admin/creatore prepara, dirigente (ruolo
  `user`, non creatore) firma, il creatore lancia. Bug storico v1.11.x: ownership
  sulla firma → 403 al dirigente. Con firmatario indicato il dirigente deve poter
  fare tutto quello che fa oggi.
- Rompere il destinatario: cittadino/link pubblico devono continuare a funzionare.

## Regola di accesso

Helper unico, backend (es. `assertCanReadAttachments(campaign, requester)` o
funzione pura `canReadAttachments(campaign, requester): boolean` testabile):

```
admin                                   → sì
requester.username === campaign.createdBy → sì
requester.username === campaign.signerUsername (non null) → sì
altrimenti                              → ForbiddenException (403)
```

Confronto username: stesso criterio già usato da `assertOwnership()` in
`CampaignsService` (uguaglianza stretta su `username` del JWT). Controllo nel
service, non nel controller (stesso pattern di `assertOwnership`, testabile).

## Endpoint da proteggere (backend, 403)

| Endpoint | File |
|---|---|
| `GET admin/campaigns/:id/attachments/preview-file` | `campaigns/campaigns.controller.ts` → `resolveAttachmentPreviewFilePath` |
| `GET admin/notifications-search/:recipientId/attachment/:index` | `notifications-search/notifications-search.controller.ts` → `downloadAttachment` (risale alla campagna dal recipient) |
| `GET admin/campaigns/:id/signature/unsigned.zip` | `remote-sign/signed-attachments.controller.ts` → `buildUnsignedZip` |
| Firma remota Aruba (avvio, stato) | `remote-sign/remote-sign.controller.ts` → `RemoteSignService.assertCanRead/assertCanModify` |
| Ricarico firmati (`signed-attachments/upload/complete`) | idem, `assertCanModify` |
| `GET admin/enrichment/jobs/:id/result.zip` | `enrichment/enrichment.controller.ts` — qui la regola usa `enrichmentJob.createdBy` + admin (nessun firmatario: il job non è una campagna) |

**Arricchimento — solo i file, non i dati estratti** (scelta di Claude, coerente
col non-obiettivo "dati destinatari visibili a tutti"): `jobs/:id/rows/:pdfFilename`,
`result.csv`, `overrides`, `stream` restituiscono dati estratti (CF, indirizzo,
importi), non il PDF → restano aperti. Si chiude solo `result.zip` (contiene i PDF).

**Arricchimento — conversione in campagna** (decisione utente): oggi
`POST admin/enrichment/jobs/:id/create-campaign` non ha controllo di ownership e
la campagna nasce con `createdBy` = chi chiama (`convert-campaign.processor.ts`):
un altro operatore diventerebbe "creatore" dei PDF del collega. Diventa
consentita solo a `enrichmentJob.createdBy` e agli admin (403 + audit per gli
altri). Se la converte un admin, `createdBy` della campagna = chi ha caricato
l'Arricchimento (non l'admin), così il caricatore conserva l'accesso agli
allegati (scelta di Claude).

## Link di download nelle anteprime backoffice (bypass da chiudere)

`GET admin/notifications-search/:recipientId` (`notifications-search.service.ts:209`)
e `POST admin/campaigns/preview` con `campaignId` + CF reale
(`campaigns.service.ts` ~295-306) rendono il messaggio tramite
`renderMessageForRecipient(recipientId, …, preview=true)`, che contiene link
`public/download` **firmati e funzionanti** per il destinatario reale
(`preview=1` salta solo contatori e `DownloadEvent`, il PDF viene servito:
`public-download.controller.ts:64-68`). Senza intervento, chiunque apre il
dettaglio notifica ottiene l'allegato con un clic.

Decisione (scelta di Claude): quando il richiedente **non** supera la regola,
il rendering backoffice sostituisce i link di download con un segnaposto non
cliccabile ("Allegato riservato"), senza generare alcuna firma. Il percorso
cittadino (`citizen.service.ts:69`, `preview=false`) e gli invii reali non
cambiano: l'intervento è un parametro/variante lato backoffice, mai una modifica
del comportamento di default di `processTemplate`. Gli operatori ammessi
continuano a vedere link funzionanti come oggi. Test: dettaglio notifica e
preview campagna per "altro user" non contengono `public/download` né `sig=`.

`RemoteSignService.assertCanRead/assertCanModify` oggi ignorano `_requester`
(commento "qualunque operatore può firmare"): diventano la regola sopra.
`assertCanModify` mantiene in più i check esistenti (SEND, DRAFT).

Init/chunk del ricarico firmati non toccano dati esistenti: il controllo resta
su `complete` (già fatto prima di assemblare), come oggi.

Il builder verifica con un grep se esistono altri endpoint che restituiscono il
**contenuto** di un allegato operatore (es. anteprima PDF generata, ZIP export)
e li aggiunge alla tabella con la stessa regola.

## Firmatario indicato

**Dato**: nuova colonna nullable su `campaigns`, es. `signer_username varchar NULL`
(nome a scelta del builder). Serve migration (prod) — in dev `synchronize`.
Esposta da `findOne`/`findAll` con display name risolto da
`OperatorDirectoryService.resolveMany` (stesso pattern di `createdByDisplayName`).

**Chi lo imposta**: creatore della campagna o admin (stessa regola di
`assertOwnership`). Endpoint dedicato, es. `PATCH admin/campaigns/:id/signer`
body `{ signerUsername: string | null }`.

**Quando**: solo campagna SEND in stato `DRAFT` (la firma esiste solo lì). Fuori
DRAFT → 400. Cambiabile/azzerabile liberamente finché DRAFT. Con un
RemoteSignJob attivo: rifiutare il cambio (400), per non togliere l'accesso a
metà firma.

**Validazione**: lo username deve esistere in `operator_directory`. Limite noto
e accettato: la tabella si popola solo al login (`AuthService.loginWithLdap`),
quindi un dirigente mai entrato non compare — deve fare login una volta.
`null` = nessun firmatario.

**Audit**: ogni impostazione/cambio/azzeramento scrive un audit log
(`operator`, campagna, vecchio → nuovo firmatario), stesso servizio già usato
dal controller campagne.

**Elenco per la scelta**: endpoint che restituisce gli operatori di
`operator_directory` (username + display name) per popolare la select. Se
esiste già un endpoint utilizzabile, riusarlo.

## Tentativi negati

Ogni 403 dalla regola scrive un audit log (operatore, campagna/job, endpoint o
azione tentata). Niente PII del destinatario nel log (id, non CF/nome).

## Frontend admin

- **Selettore firmatario** nel pannello firma della campagna SEND in bozza
  (`components/signature/SignaturePanel.tsx`), visibile/modificabile solo a
  creatore e admin; per gli altri sola lettura ("Firmatario: Nome Cognome").
  Testo d'aiuto: chi non compare nell'elenco deve accedere una volta a ComunicaPA.
- **Bottoni allegato** (anteprima `App.tsx` ~644, download da ricerca notifiche
  `App.tsx` ~1947, ZIP da firmare e firma remota in `SignaturePanel`/
  `UnsignedDecisionModal`, ZIP risultato Arricchimento): nascosti o disabilitati con
  tooltip "Allegato visibile solo a chi ha creato la campagna, agli
  amministratori e al firmatario indicato" per chi non ha accesso. Il backend
  espone un flag calcolato (es. `canReadAttachments: boolean` nel dettaglio
  campagna e nel dettaglio ricerca notifiche) — il frontend non ricalcola la
  regola.
- Se nonostante tutto arriva un 403, messaggio leggibile, non errore generico.

## Campagne esistenti

Nessun backfill: `signer_username` = NULL ovunque → da subito leggono solo
creatore e admin. Una bozza SEND già in attesa di firma di un dirigente si
blocca per il dirigente finché il creatore (o un admin) non lo indica.
Accettato dall'utente. Da segnalare nelle note di rilascio e nella guida.

## Guida operatori

Stessa PR: aggiornare `apps/frontend-admin/public/guida/guida.md` (data in
testa) — chi vede gli allegati, come indicare il firmatario, voce in "Problemi
frequenti" (Causa: non sei creatore/admin/firmatario; Soluzione: chiedi al
creatore di indicarti come firmatario; il firmatario non compare → deve fare
login una volta). Rispettare `scripts/check-guida.mjs`.

## Test

- Unit sulla regola (funzione pura): admin, creatore, firmatario, altro `user`,
  firmatario null.
- Service: preview-file, download da ricerca notifiche, unsigned.zip, firma
  remota (avvio + ricarico), enrichment PDF/ZIP → 403 per "altro user", ok per
  i tre ammessi.
- Conversione Arricchimento: altro `user` → 403; admin → campagna con
  `createdBy` = caricatore del job.
- Anteprime backoffice: per "altro user" nessun link `public/download`/`sig=`.
- Endpoint firmatario: solo creatore/admin, solo SEND DRAFT, rifiuto con job
  firma attivo, username inesistente → 400, audit scritto.
- Regressione flusso firma: dirigente indicato come firmatario completa firma
  remota e ricarico come oggi.
- Portale cittadino e `public/download` invariati (test esistenti verdi).

## Lasciato al builder

- Nomi esatti di colonna, endpoint, helper, testi UI.
- Struttura migration (seguire `docs/claude/database-queue.md`).
- Se il flag `canReadAttachments` vive in `findOne` o in un endpoint separato.
- Formato del record audit, riusando i campi già esistenti.
