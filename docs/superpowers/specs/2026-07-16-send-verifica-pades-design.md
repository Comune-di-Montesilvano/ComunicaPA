# Verifica firma PAdES allegati SEND

## Contesto

Per il canale SEND (PN/notifichedigitali.it) l'allegato PDF è il contenuto
notificato legalmente (atto), non un corredo opzionale — obbligo già presente
(CLAUDE.md, "Allegato obbligatorio per SEND e POSTAL"). Oggi nessun controllo
verifica che il PDF caricato abbia una firma digitale valida prima
dell'invio: un PDF non firmato o con firma corrotta viene accettato da PN e
notificato comunque, scoperto solo a valle (contestazione legale). `pdf-lib`
(unica dipendenza PDF esistente in `apps/backend/package.json`) manipola PDF
ma non verifica firme — nessuna libreria di verifica firma è già presente.

## Obiettivo

Verificare, prima del lancio di una campagna SEND, che ogni PDF allegato
effettivamente destinato all'invio contenga una firma digitale PAdES/CMS
strutturalmente valida (hash del documento coerente col byte range firmato —
niente manomissioni post-firma). Attivo di default, disattivabile da
checkbox nel wizard. Non verifica la catena di certificazione (CA/CRL/OCSP):
quella la valida PN stesso in fase di accettazione — questo controllo serve
solo a intercettare PDF non firmati o corrotti *prima* di spedirli, non a
duplicare la validazione legale di PN.

## Libreria

Nessuna libreria esistente copre questo caso. Aggiungere `node-forge`
(parsing PKCS7/CMS, calcolo digest, verifica firma RSA/hash) come dipendenza
backend. La verifica PAdES si implementa a mano in ~100 righe:

1. Leggere il PDF grezzo, estrarre `/ByteRange` e `/Contents` dal dizionario
   di firma (`/Type /Sig`) — sono campi testuali nel PDF, non serve un parser
   PDF completo.
2. Calcolare l'hash del documento sui byte indicati da `/ByteRange`
   (esclude la firma stessa, come da spec PAdES).
3. Decodificare `/Contents` (hex) come PKCS7/CMS `SignedData` con
   `node-forge`, estrarre il digest firmato e la firma.
4. Verificare che il digest firmato corrisponda all'hash calcolato al punto 2
   e che la firma RSA sia valida rispetto al certificato incluso nel PKCS7
   (verifica crittografica pura, non catena di trust).

Nessuna chiamata di rete (niente OCSP/CRL) — coerente con la decisione di non
verificare la catena di certificazione, e mantiene il controllo veloce e
deterministico anche offline.

Esito: `{ signed: boolean, valid: boolean, reason?: string }` — `signed=false`
per PDF senza dizionario di firma, `valid=false` per firma presente ma hash
non corrispondente (documento modificato dopo la firma) o PKCS7 malformato.

## Dove gira il controllo

Segue il pattern già stabilito per l'allegato mancante
(`campaigns.service.ts`, `findMissingAttachments()` chiamato da `launch()`):
la verifica PAdES è **autoritativa solo al lancio**, sugli stessi file
fisici che `findMissingAttachments()` già enumera per la campagna (stessa
risoluzione allegato-per-destinatario, incluso `labelColumn` dinamico —
CLAUDE.md "Etichetta allegato dinamica per destinatario").

In `CampaignsService.launch()`, se `channelConfig.verifyPades !== false` e
`wizChannel === 'SEND'`: dopo il check allegati mancanti, verifica ogni PDF
univoco effettivamente mappato. Se uno o più falliscono (non firmati o firma
non valida), stesso pattern 200+`blocked:true` già usato per
`missingAttachments` (mai eccezione non-2xx, il proxy esterno la
sostituirebbe con una pagina HTML illeggibile) — status campagna torna a
`DRAFT`, risposta include l'elenco dei file non conformi con la ragione
(`non firmato` / `firma non valida`).

Nessun controllo best-effort separato al momento dell'upload allegati: un
solo punto di verità (il lancio) evita di duplicare la logica di
risoluzione-allegato-per-destinatario in due posti diversi con rischio di
disallineamento.

## Frontend — wizard

Step rinominato da "Riepilogo & Spedizione" ad **"Allegati e Invio"**
(`apps/frontend-admin/src/App.tsx`, header step5, solo per canale SEND — per
gli altri canali il nome resta invariato dato che lì l'upload allegati è già
avvenuto prima). Nuova checkbox `wizVerifyPades` (default `true`), visibile
solo quando `wizChannel === 'SEND'`, posizionata nella card "Carica gli
Allegati PDF per questa Spedizione" subito sotto l'input file:

```
[x] Verifica firma digitale PAdES sui PDF prima dell'invio (consigliato)
    Se disattivata, PDF non firmati o con firma non valida vengono inviati comunque a SEND.
```

Il valore va in `channelConfig.verifyPades` (blocco SEND di `handleWizLaunch`,
`apps/frontend-admin/src/App.tsx` ~riga 3428, accanto a `taxonomyCode`/
`physicalCommunicationType`). Se `handleWizLaunch` riceve `blocked: true` con
la lista PDF non conformi, la mostra con lo stesso pattern di errore già
usato per gli altri blocchi noti (alert con messaggio, nessuna eccezione non
gestita).

## Fuori scope

- Nessuna verifica catena di certificazione/CA/revoca (OCSP/CRL) — solo
  struttura firma + integrità hash documento.
- Nessun controllo per canale POSTAL (l'obbligo firma PAdES è specifico a
  SEND: gli allegati postali sono stampati, non richiedono firma digitale).
- Nessuna UI di dettaglio "visualizza certificato firmatario" — l'esito è
  binario (valida/non valida) con motivo testuale, non un pannello
  ispezione certificato.
