# Firma remota Aruba (ARSS) e ricarico allegati firmati

**ARSS verificato dal vivo (2026-10-13)** con firma remota OTP personale, senza contratto dedicato:
endpoint SOAP pubblico `https://arss.arubapec.it/ArubaSignService/ArubaSignService?wsdl`
(schema inline; `ping` → `pong` senza auth). L'URL REST di ArubaSign
(`app1.firma-remota.it/ArubaSignerService/webresources/signerservice`) risponde
500 a tutto senza auth: non usato.

- `auth`: `user`, `userPWD`, `otpPwd`, `typeOtpAuth` (= dominio, `firma`), `typeHSM=COSIGN`.
- `opensession{Identity}` → `return` = sessionid (nessuno status/return_code nella risposta riuscita). L'OTP serve SOLO qui.
- `pdfsignatureV2{SignRequestV2{binaryinput, certID=AS0, identity (senza otpPwd, con userPWD), requiredmark=false, session_id, transport=BYNARYNET}, pdfprofile=PADESBES}` → `return.status=OK`, `return_code=0000`, `binaryoutput` base64. Non verificato se basti la sessione senza `userPWD`: per questo la password viaggia nel job cifrata `enc:v1:`.
- `closesession{Identity, sessionid}` → `OK`.
- Output `/SubFilter /ETSI.CAdES.detached`, valido per `SignatureVerificationService` (TSL AgID).
- Durata sessione NON nota: il job logga "Firma remota … N/M file in S s" e su scadenza scrive in `errorMessage` "Sessione scaduta dopo X file su N (S s)". Leggere i log prod per tararla; se troppo breve valutare `pdfsignatureV2_multiple`.
- Codici ARSS non documentati pubblicamente: `classifyArssError` usa `0030` = dominio e il testo della descrizione; i warning loggano codice+descrizione grezzi (senza segreti) per affinare.

**Backup originali fuori da uploads.** `replaceAttachment` copia l'originale in
`<attachmentsRoot>/unsigned-backup/<campaignId>/` alla prima sostituzione. Mai
dentro `getUploadsDir`: `finalizeAttachments` cancella ogni voce non
referenziata dal CSV (una sottocartella romperebbe `unlinkSync`) e in caso di
blocco svuota tutta la cartella. Pulizia insieme a uploads in `remove()`,
`retention-cleanup.service.ts`, `campaign-completion.service.ts`.

**Ordine a fine job:** `closeSession` → `startForCampaign` (nuova verifica) →
update stato `done`/`failed`. Invertendo, la UI legge per un istante la verifica
vecchia e riapre la modale "non firmati".

**Ricarico firmati** (`signed-attachments/upload/*`): mai `finalizeAttachments`,
estrazione in tmp, `matchSignedFiles` (nome identico o suffissi
`-signed`/`_signed`/`.signed`/`-firmato`/`_firmato`/` (firmato)`, ambigui e già
validi rifiutati), elenco entry da `adm-zip` perché `extractZipWithYauzl`
scarta in silenzio i non-PDF (`.p7m` compresi).

**Limite noto:** `extractPdfSignature` legge la PRIMA firma del PDF: un PDF con
una firma preesistente non valida resta invalido anche dopo la firma Aruba.

**Riconciliazione all'avvio:** `RemoteSignReconcileService` (`OnApplicationBootstrap`)
segna `failed` ogni RemoteSignJob `queued`/`processing` ("Firma interrotta da un
riavvio del server: rilancia con un nuovo OTP") e rimuove il job BullMQ. Dopo un
riavvio la sessione OTP è inaffidabile e una ri-esecuzione ri-firmerebbe file già
firmati (signatureCheck stale). Assume una sola istanza backend.

**Gate:** con un RemoteSignJob attivo sono bloccati `launch()` (SEND massivo e
Invio Manuale) e `assertDraftForAttachments` (upload allegati): il ramo blocked di
`finalizeAttachments` svuoterebbe uploads a metà firma.

**Processor:** errori di filesystem per singolo file = file fallito, il job
prosegue; si ferma solo su `RemoteSignError` session/network/domain/credentials.

**ZIP da firmare:** adm-zip con entry STORED (method 0), lettura async,
`toBufferPromise()`. ZIP caricato corrotto → 200 `{ error: 'ZIP non valido o danneggiato' }`.

**Frontend:** `apiFetch` di App non è memoizzato → nei componenti
`components/signature/` i polling tengono apiFetch/callback in ref (altrimenti
l'intervallo si resetta a ogni render di App). `RemoteSignModal` usa `createPortal`.
