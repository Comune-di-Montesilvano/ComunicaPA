# Verifica firma digitale allegati SEND — design

Data: 2026-09-14

## Obiettivo

Gli allegati SEND sono atti a valore legale (obbligatori, vedi matrice
comportamenti campagne). Oggi non esiste alcuna verifica che il PDF/`.p7m`
caricato sia effettivamente firmato digitalmente con una firma qualificata
valida. Serve:

- **Invio singolo**: avviso non bloccante se l'allegato non risulta firmato
  correttamente — l'operatore può comunque procedere.
- **Invio massivo**: blocco del lancio finché tutti gli allegati non
  risultano verificati con firma valida.

## Perimetro (deciso in brainstorming)

- **Livello di verifica**: crittografico completo — integrità della firma,
  certificato non scaduto, catena che risale a una CA nella **TSL italiana
  AgID** (`https://eidas.agid.gov.it/TL/TSL-IT.xml`, ETSI TS 119612). **Non**
  in perimetro: controllo di revoca (OCSP/CRL) — richiederebbe chiamate di
  rete sincrone verso i servizi delle CA ad ogni verifica, fuori scope per
  questa prima versione. **Non** in perimetro: EU LOTL completa (27 paesi) —
  solo la TSL italiana, sufficiente per comunicazioni di un Comune italiano;
  estendibile in futuro senza rompere questa versione (stesso principio
  YAGNI già in uso per `PostalProviderType` con un solo provider oggi).
- **Formati supportati**: PDF con firma PAdES embedded (`/ByteRange` +
  `/Contents` nel dizionario di firma) e `.p7m` CAdES (intero file come
  envelope PKCS7/CMS). Firme multiple sullo stesso file: verificarle tutte,
  il documento è valido se **almeno una** firma è valida e riconducibile
  alla TSL (comportamento standard PAdES/CAdES per firme multiple/co-firma).
- **Riguarda solo il canale SEND** — non EMAIL/PEC/POSTAL/APP_IO (per quei
  canali l'allegato non ha lo stesso vincolo di valore legale via firma
  qualificata).
- **Invio massivo**: verifica **sempre** eseguita in background (job
  BullMQ dedicato), mai sincrona nella request — stesso principio già
  documentato in CLAUDE.md per lavoro pesante sincrono in un handler HTTP
  (crypto su centinaia/migliaia di PDF affamerebbe l'event loop, stesso
  incidente reale già capitato con unzip/scritture pesanti
  nell'arricchimento tracciati).

## Componenti

### 1. Modulo `signature-verification` (nuovo)

- **`AgidTrustListService`**: scarica e parsa `TSL-IT.xml` (ETSI TS 119612
  — `fast-xml-parser` o `xml2js`, già presente nell'ecosistema npm, nessuna
  dipendenza nuova pesante), estrae i certificati X.509 delle CA qualificate
  italiane. Cache in una tabella dedicata `agid_trust_list_cache` (blob
  JSON dei certificati estratti + `fetched_at`), refresh via `@Cron`
  giornaliero (stesso pattern di `PostalStatusSyncService`). Se il fetch
  fallisce, si usa l'ultima cache valida — mai bloccare tutte le verifiche
  per un TSL momentaneamente irraggiungibile (fail-open sulla
  disponibilità del TSL, fail-closed sulla singola firma non verificabile).
- **`SignatureVerificationService`**: dato un `Buffer` + nome file,
  rileva il formato (estensione + magic bytes: `%PDF` vs struttura ASN.1
  PKCS7), estrae la/le firma/e, verifica con `node-forge`
  (parsing ASN.1/PKCS7/X.509 maturo, nessuna chiamata di rete — libreria
  nuova da aggiungere, unica dipendenza nuova di questa feature). Ritorna
  `{ valid: boolean; reason?: string; signerCn?: string; signedAt?: Date }`.
  `reason` copre i casi diagnosticabili: non firmato, firma corrotta,
  certificato scaduto, CA non in TSL.

### 2. Invio singolo (wizard)

Al passo allegato del wizard singolo SEND, dopo l'upload il file viene
verificato **sincronamente** (un solo file, costo trascurabile — nessun
job). Se non valido, banner di avviso (stesso stile "alert-warning" già
usato altrove nel wizard) con il motivo (`reason`) — l'operatore può
comunque premere "Avvia Test"/"Conferma".

### 3. Invio massivo — job BullMQ dedicato

Nuova entity `SignatureVerificationJob` (stesso pattern di
`InadVerificationJob`): `id`, `campaignId`, `status`
(queued/processing/done/failed), `totalRows`, `validCount`,
`invalidCount`, `results` (jsonb, chiave = recipientId, valore =
`{valid, reason}`), `createdAt`, `completedAt`.

Trigger: al passo 3 del wizard massivo (mappatura CSV → allegati), quando
il canale è SEND e gli allegati sono configurati, si accoda un job che
itera ogni `Recipient` già sincronizzato in bozza (stesso principio già
in uso per `syncWizDraftAndRecipients` — i Recipient esistono in bozza
prima del lancio reale), risolve il file allegato per ciascuno
(`resolveCustomAttachmentFilename`, già esistente in
`attachment.service.ts`), verifica la firma, scrive il risultato per
riga in `results`.

`CampaignsService.launch()`: nuovo controllo, analogo a
`checkAttachmentsBlocking` (stesso punto, stesso pattern 200+
`{blocked:true}`, mai eccezione non-2xx) — se `channelType === 'SEND'` e
l'ultimo `SignatureVerificationJob` per la campagna non è `done` con
`invalidCount === 0`, blocca con messaggio che riporta quanti allegati
non risultano firmati validi. Se il job non esiste ancora per la
campagna (bozza mai passata dal passo 3, o modificata dopo l'ultima
verifica — stessa fingerprint già usata per `wizRecipientsSyncFingerprint`),
il lancio è comunque bloccato con messaggio "Verifica firma in corso o
mai eseguita".

### 4. Storage esito per destinatario

Nuove colonne su `Recipient` (stesso stile jsonb di `inadCheck` già
esistente): `signatureCheck: { valid: boolean; reason: string | null;
checkedAt: string } | null`. Il dettaglio campagna (tabella destinatari)
mostra un badge "Firma non valida" per le righe con `signatureCheck.valid
=== false`, cliccabile per il motivo — stesso principio della colonna
"Errore" già in uso per POSTAL/SEND.

## Frontend (`frontend-admin`)

- Wizard singolo SEND, step allegato: banner avviso non bloccante (vedi
  sopra).
- Wizard massivo SEND, step 3 (dopo mappatura allegati): stato del job
  (in corso / completato — X validi, Y non validi) con polling 3s (stesso
  pattern già in uso per stato campagna), bottone "Riavvia verifica" se
  l'operatore sostituisce un allegato dopo un fallimento.
- Bottoni "Avvia campagna"/"Lancia" disabilitati finché il job non è
  `done` con `invalidCount === 0` — **verificare tutte le occorrenze
  duplicate** del bottone lancio (gotcha noto: bottoni Avanti/Indietro
  duplicati in cima/fondo allo step, CLAUDE.md).
- Dettaglio campagna: badge "Firma non valida" per riga (vedi sopra).

## Test

- `AgidTrustListService`: parsing XML con fixture reale (scaricare una
  copia della TSL-IT per i test, non fare fetch di rete nei test), cache
  fallback se il fetch fallisce.
- `SignatureVerificationService`: fixture reali — un PDF firmato
  validamente (PAdES), uno con firma scaduta, uno non firmato, un `.p7m`
  valido, un `.p7m` corrotto. **Mai usare CF/dati reali nei fixture di
  test** (memoria: no PII reale nel codice) — generare firme di test con
  una CA self-signed locale, non certificati reali di persone.
- `CampaignsService.launch()`: nuovo branch di blocco per SEND con job non
  `done`/`invalidCount>0`, audit dei `Test.createTestingModule` esistenti
  (stesso principio già applicato per `PostalAuthorizedUsersService`).
- E2E: un invio singolo con PDF non firmato deve mostrare il banner ma
  permettere il lancio; un invio massivo con anche un solo allegato non
  firmato deve bloccare il lancio.

## Fuori perimetro (non in questa feature)

- Controllo di revoca (OCSP/CRL).
- EU LOTL completa (solo TSL italiana).
- Verifica firma per canali diversi da SEND.
- Ri-verifica periodica di firme già validate (una firma valida al momento
  del lancio resta tale nel record — non si ri-verifica a posteriori).
