# Firma allegati SEND dal wizard — design

_2026-10-13_

## Obiettivo

Nel wizard SEND (massivo allo step 6/7, Invio Manuale all'invio), quando la verifica firma trova allegati
senza firma digitale valida (tipico delle campagne da Arricchimento Tracciati,
PDF con firma autografa a stampa), l'operatore può firmarli senza uscire da
ComunicaPA:

1. **Firma con Aruba** — firma remota OTP Aruba (ARSS), un solo OTP per tutto
   il lotto, eseguita dal backend in background.
2. **ZIP** — scarica i PDF da firmare, li firma con il proprio strumento
   (Dike, ArubaSign, token locale), ricarica i firmati.

Successo: la verifica firma diventa verde senza ricorrere alla forzatura
introdotta in v1.10.2 (che resta disponibile).

## Fatti verificati (spike 2026-10-13)

Firma remota OTP personale dell'operatore, nessun contratto ARSS dedicato:

- Endpoint SOAP pubblico `https://arss.arubapec.it/ArubaSignService/ArubaSignService`
  (WSDL `?wsdl`, schema inline; `ping` → `pong` senza autenticazione).
- `auth`: `user`, `userPWD`, `otpPwd`, `typeOtpAuth` (dominio, `firma` per la
  firma remota personale), `typeHSM` (`COSIGN`).
- `opensession{Identity}` → `return` = sessionid (l'OTP serve solo qui).
- `pdfsignatureV2{SignRequestV2{binaryinput, certID=AS0, identity (senza
  otpPwd), requiredmark=false, session_id, transport=BYNARYNET},
  pdfprofile=PADESBES}` → `status=OK`, `return_code=0000`, `binaryoutput`.
- `closesession{Identity, sessionid}` → `OK`.
- Output `/SubFilter /ETSI.CAdES.detached`, accettato da
  `SignatureVerificationService.verify()` con TSL AgID (valid, `signerCn`
  valorizzato).
- **Non verificato**: durata della sessione (per tempo totale o inattività).
  Si misura in produzione: il job registra file firmati e secondi trascorsi
  allo scadere della sessione.

## Perimetro

- Campagne SEND in bozza: **massive** (step 6/7) e **Invio Manuale**
  (`wizSingleMode = true`). Firma Aruba per entrambe; ZIP solo nel massivo
  (nel manuale i file sono pochi e scelti a mano: si riseleziona il firmato).
- File da firmare = allegati dei destinatari `PENDING` con
  `signatureCheck.valid = false` nell'ultima verifica `done`, nomi
  deduplicati, `.p7m` esclusi (SEND vuole PDF/PAdES).
- Firma **invisibile** (nessun riquadro grafico), profilo `PADESBES`.
- Credenziali Aruba digitate al momento: **mai** salvate (né DB, né Redis, né
  log). In Impostazioni solo parametri di servizio.

## Impostazioni

Nuove chiavi in `settings.registry.ts`, sezione UI "Firma remota":

| Chiave | Tipo | Default |
|---|---|---|
| `remoteSign.enabled` | boolean | `false` |
| `remoteSign.wsdlUrl` | string | `https://arss.arubapec.it/ArubaSignService/ArubaSignService?wsdl` |
| `remoteSign.otpDomain` | string | `firma` |
| `remoteSign.typeHsm` | string | `COSIGN` |
| `remoteSign.certId` | string | `AS0` |

Con `enabled = false` il bottone "Firma con Aruba" non compare; lo ZIP è
sempre disponibile.

**Prova firma**: `POST admin/settings/remote-sign/test` `{ user, password,
otp }` → apre sessione, firma un PDF fisso di prova (generato in memoria,
nessun dato reale), lo verifica con `SignatureVerificationService`, chiude la
sessione. Risposta 200 `{ ok: true, signerCn }` oppure `{ ok: false, error }`.
Niente su disco. Solo admin.

## Backend — firma Aruba

Modulo `apps/backend/src/remote-sign/`.

### `aruba-sign.client.ts`

Client SOAP (libreria `soap`, come GlobalCom/TINN), parametri da settings:

- `openSession(user, password, otp): Promise<string>`
- `signPdf(sessionId, user, password, pdf: Buffer): Promise<Buffer>` —
  `identity` con `user`, `userPWD`, `typeHSM`, `typeOtpAuth`, **senza**
  `otpPwd`; `session_id` valorizzato; `PADESBES`. Stessa forma verificata
  nello spike (che includeva `userPWD`): non è noto se l'ARSS firmi in
  sessione anche senza password, quindi la si passa sempre.
- `closeSession(sessionId, user): Promise<void>` — mai lancia (best effort).

Errori ARSS → `RemoteSignError { kind, message }` con `kind`:
`credentials` (credenziali/OTP errati), `domain` (es. `0030`), `session`
(sessione scaduta/invalida), `file` (singolo PDF rifiutato), `network`.
Messaggi in italiano. Mai loggati: password, OTP, sessionid, binari.

### Entità `RemoteSignJob` (tabella `remote_sign_jobs`, migration)

`id` uuid, `campaignId` uuid, `status` (`queued`/`processing`/`done`/`failed`),
`totalFiles`, `signedCount`, `failedCount` int, `errorMessage` text null,
`errorKind` varchar null, `operator` varchar, `signerCn` varchar null,
`createdAt`, `completedAt` timestamptz null.

### Flusso

1. `POST admin/campaigns/:id/remote-sign` `{ user, password, otp }`
   (DTO validato). Precondizioni, altrimenti 200 `{ error }`:
   - campagna SEND in `DRAFT` (massiva o manuale), ownership come le altre route;
   - ultima verifica firma `done` con `invalidCount > 0`;
   - nessun `RemoteSignJob` `queued`/`processing` per la campagna.
2. `openSession` **dentro la richiesta**: OTP/credenziali errati → 200
   `{ error }` immediato, nessun job.
3. Crea `RemoteSignJob` e accoda su `remote-sign-jobs` (concorrenza 1)
   `{ jobId, campaignId, sessionId, user, passwordEnc }`: `passwordEnc` cifrata
   con la stessa chiave AES-256-GCM dei secret di settings (mai in chiaro su
   Redis). `removeOnComplete` / `removeOnFail` sempre: alla fine del job non
   resta nulla in coda. Ottimizzazione futura, fuori perimetro: se una prova
   reale dimostra che `pdfsignatureV2` in sessione non richiede `userPWD`, la
   password si toglie dal job.
4. Processor, per ogni file:
   - prima sovrascrittura → copia originale in `getUnsignedBackupDir(id)`
     (`<attachmentsRoot>/unsigned-backup/<campaignId>/`). **Mai** dentro
     `getUploadsDir`: `finalizeAttachments` scarta/cancella ogni voce non
     referenziata dal CSV, sottocartelle incluse;
   - `signPdf` → scrittura atomica (`<file>.tmp` + `rename`) sopra
     l'originale, stesso nome;
   - errore `file` → `failedCount++`, prosegue;
   - errore `session`/`network`/`domain` → stop, job `failed` con
     `errorKind` e messaggio "Sessione scaduta dopo X file su N (Y s)";
   - aggiorna `signedCount` a ogni file (polling UI).
5. `finally`: `closeSession`, poi `SignatureVerificationBulkService.startForCampaign`.
6. Audit `REMOTE_SIGN` `{ jobId, signerCn, signed, failed, total, errorKind }`.

`GET admin/campaigns/:id/remote-sign` → ultimo job (`status`, contatori,
`errorKind`, `errorMessage`), 404 se mai avviato.

`signerCn`: estratto dal primo PDF firmato con `SignatureVerificationService`.

### Gate in `launch()`

SEND (massivo e manuale): se esiste un `RemoteSignJob` `queued`/`processing`
→ `blocked` "Firma remota in corso". Senza, l'ultima verifica `done` (precedente alla
firma) lascerebbe lanciare a metà firma.

### Ripresa

Sessione scaduta a metà: i file firmati restano firmati, la nuova verifica li
vede validi, un nuovo tentativo con nuovo OTP firma solo i rimanenti.

### Pulizia

`getUnsignedBackupDir` rimosso negli stessi punti di `getUploadsDir`:
`campaigns.service.ts` (`remove`, incluso il test collegato),
`retention-cleanup.service.ts`, `campaign-completion.service.ts`.

## Backend — ZIP

### Download

`GET admin/campaigns/:id/signature/unsigned.zip` — PDF da firmare (stesso
elenco della firma Aruba) con il **nome originale**, costruito con `adm-zip`.
Precondizione: ultima verifica `done`. Il frontend lo scarica con `fetch`
autenticato e salva il blob.

### Ricarico

Riusa `:id/attachments/upload/init` e `.../chunk/...` (chunked, sotto il
limite del reverse proxy). Nuovo complete:
`POST admin/campaigns/:id/signed-attachments/upload/complete/:uploadId`.
Accetta ZIP o singolo PDF. **Non** riusa `finalizeAttachments` (in caso di
blocco svuota la cartella).

1. Estrazione in cartella temporanea (`extractZipWithYauzl`), mai in uploads.
2. Abbinamento con funzione pura
   `signed-attachment-matcher.util.ts::matchSignedFiles(uploaded, expected, alreadyValid)`:
   - case-insensitive;
   - nome identico a un atteso, oppure tolto un suffisso noto prima di
     `.pdf`: `-signed`, `_signed`, `.signed`, `-firmato`, `_firmato`,
     ` (firmato)`;
   - rifiuti con motivo: `.p7m` ("serve firma PAdES, non CAdES"), non PDF,
     nessun abbinamento, ambiguo (più file sullo stesso originale: tutti
     scartati), originale già valido (mai sovrascrivere un file buono).
3. Abbinati → backup (come sopra) e copia sopra l'originale col nome
   originale.
4. `startForCampaign` (nuova verifica).
5. Risposta 200 `{ replaced, rejected: [{ file, reason }] }`.
6. Audit `UPLOAD_SIGNED_ATTACHMENTS`.

Precondizioni: bozza, nessun `RemoteSignJob` attivo.

Il CSV non viene mai toccato: la colonna `allegato` resta il nome originale.

## Frontend

### Step 6/7

Nuovo `components/signature/SignaturePanel.tsx` sostituisce il banner
attuale (stessi stati: in corso / tutti validi / N non validi). Con N non
validi:

- **Firma con Aruba** (solo se abilitata: `GET admin/remote-sign/config` →
  `{ enabled }`, leggibile da ogni operatore — le settings sono solo admin);
- **Scarica ZIP da firmare**;
- **Carica firmati** (upload chunked con barra di avanzamento, poi elenco
  scartati: max 20 + "e altri N").

La forzatura v1.10.2 sul bottone di lancio resta invariata.

### Invio Manuale

Oggi `ensureWizSingleAttachmentsUploaded` carica gli allegati e
`triggerAndAlertSignatureVerification` attende la verifica; con file non
validi `confirmContinueDespiteInvalidSignature` mostra un `window.confirm`
OK/Annulla. Diventa una modale con tre scelte:

- **Firma con Aruba** (solo se `remoteSign.enabled`) → `RemoteSignModal`;
  a job concluso attende la nuova verifica: tutti validi → l'invio
  **riprende da solo** (stesso punto del flusso); ancora invalidi → di nuovo
  la modale a tre scelte;
- **Invia comunque** (comportamento attuale di OK);
- **Annulla** (comportamento attuale).

`triggerAndAlertSignatureVerification` resta la via unica per avviare e
attendere la verifica; la decisione dell'operatore viene restituita al
chiamante (`'continue' | 'cancel'`), la firma Aruba è un ramo interno.

### `RemoteSignModal.tsx`

Campi utente, password, OTP. Username ricordato in `localStorage` (try/catch),
password mai (`autocomplete="off"`, svuotata alla chiusura). Dopo l'invio:
"Firma in corso X/N" con polling `GET .../remote-sign` ogni 3 s; a fine job
il pannello segue la nuova verifica. `errorKind = session` → messaggio e
modale riaperta per un nuovo OTP. Riusata da "Prova firma" in Impostazioni.

### Impostazioni

Sezione "Firma remota": attiva, endpoint, dominio, `typeHSM`, `certID`,
bottone **Prova firma** (mostra il firmatario trovato o l'errore).

## Errori visibili

| Caso | Effetto |
|---|---|
| Credenziali/OTP errati | Errore nella modale, nessun job |
| Dominio non abilitato | "Dominio non abilitato: verifica Impostazioni → Firma remota" |
| Sessione scaduta | "Sessione scaduta dopo X file su N (Y s): inserisci un nuovo OTP per i rimanenti" |
| Aruba non raggiungibile | Job `failed`, file già firmati restano |
| Singolo PDF rifiutato | `failedCount`, resta invalido in verifica |
| ZIP: file non abbinati | Elenco con motivo |
| Lancio durante firma | Bloccato "Firma remota in corso" |

## Test

- `signed-attachment-matcher.util.spec.ts`: identico, suffissi, case,
  ambiguo, `.p7m`, estraneo, già valido.
- `aruba-sign.client.spec.ts` (`soap` mockato): forma richieste
  (`session_id`, `PADESBES`, niente `otpPwd` in firma), mappatura errori,
  nessun segreto nei log.
- `remote-sign.processor.spec.ts`: solo invalidi, backup alla prima
  sovrascrittura fuori da uploads, scrittura atomica, stop su `session`,
  prosegue su `file`, `closeSession` + nuova verifica nel `finally`.
- `remote-sign.service.spec.ts`: precondizioni, `openSession` sincrono, job
  data con `passwordEnc` (mai la password in chiaro), `config` per operatore.
- `campaigns.service.spec.ts`: `launch()` bloccato con job attivo (massivo e
  manuale); pulizia backup in `remove`.
- Controller: DTO, risposte 200 `{ error }`, audit.
- Frontend: `tsc -p tsconfig.app.json`.
- E2E manuale: ZIP in locale su campagna di prova; Aruba in produzione su
  massivo e su Invio Manuale (ripresa automatica dell'invio dopo la firma)
  (decisione utente), durata sessione letta dai log/`errorMessage`.

## Documentazione

- Guida operatori: "Operazioni frequenti › Firmare gli allegati SEND", voce
  Problemi frequenti aggiornata, data in testa.
- `docs/claude/remote-sign.md` (campi ARSS, backup fuori da uploads, gotcha)
  + riga indice in `CLAUDE.md`.
- `docs/claude/ci-cd-deps.md`: nota corretta su `gh pr merge` (il
  classificatore auto mode può negarlo → `! gh pr merge …` dall'utente).

## Fuori perimetro

- `pdfsignatureV2_multiple` (ottimizzazione solo se la durata sessione lo
  impone).
- Ripristino originali da UI (backup solo per recupero manuale).
- Firma visibile, firma automatica (HSM senza OTP), credenziali salvate.
- ZIP nell'Invio Manuale.
