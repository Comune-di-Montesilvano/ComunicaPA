# Allegati e co-consegna App IO

## Allegati e co-consegna App IO — gotcha

**Wizard: due punti separati costruiscono `channelConfig`, vanno tenuti allineati.**
`buildWizChannelConfigDraft()` (bozza) è già channel-agnostic per `secondaryChannels`;
`handleWizLaunch()` (lancio reale) costruisce `channelConfig` per-branch,
un ramo per canale. Bug reale: aggiungendo co-consegna App IO a POSTAL, la
bozza la salvava correttamente ma `handleWizLaunch()` non la scriveva affatto
per quel canale (il blocco `secondaryChannels` viveva solo dentro il ramo
`EMAIL`/`PEC`) — la campagna partiva senza App IO nonostante la UI la
mostrasse configurata. Ogni nuovo campo channel-agnostic in `buildWiz...Draft`
va replicato anche in `handleWizLaunch`, non solo nell'uno o nell'altro.

**Stesso bug, altre due istanze reali: `attachments` e `wizSingleMode`
mancanti in `handleWizLaunch`.** `campaigns.service.ts` fa **replace
completo** di `channelConfig` sul PATCH (`if (dto.channelConfig !==
undefined) campaign.channelConfig = dto.channelConfig`, nessun merge) —
quindi un ramo di `handleWizLaunch` che dimentica un campo lo CANCELLA
dalla campagna già sincronizzata in bozza, non lo lascia semplicemente
invariato. Bug reale #1: i branch POSTAL e SEND non includevano
`attachments: wizAttachments` (a differenza di EMAIL/PEC/APP_IO che ce
l'hanno) — l'allegato già sincronizzato in bozza spariva al lancio,
bloccando con "allegato obbligatorio" nonostante l'anteprima (che legge lo
stato client `wizAttachments`, non ancora sovrascritto) lo mostrasse
correttamente. Bug reale #2: nessun branch impostava
`wizSingleMode` — `campaigns.service.ts` legge
`isWizSingleMode = channelConfig['wizSingleMode'] === true` per decidere
se saltare il check INAD bulk (pensato solo per campagne CSV, mai per un
destinatario singolo); assente, un invio singolo veniva trattato come
bulk e INAD ha dirottato una raccomandata POSTAL su PEC a sua insaputa.
Fix: `channelConfig.attachments = wizAttachments` in ogni branch che lo
richiede, `channelConfig.wizSingleMode = wizSingleMode` sempre,
incondizionatamente, per qualunque canale.

**Terzo punto di sync, oltre ai due sopra: il lifecycle del wizard stesso.**
Un nuovo stato `wiz*` legato a `channelConfig` (es. `wizPecReserveMailConfigId`)
va anche azzerato in `resetWizard()` e ripristinato in `prefillWizardFrom()`
— altrimenti il valore di una campagna trapela silenziosamente sulla
successiva (mai azzerato) o si perde riprendendo una bozza/duplicando
(mai ripristinato dal `channelConfig` salvato).

**POSTAL: `channelConfig.body`/`subject` NON sono il contenuto reale inviato.**
La lettera cartacea viene generata dagli allegati (PDF), non da un body HTML
come per EMAIL/PEC — `PostalStrategy.send()` non legge mai `channelConfig.body`.
Di conseguenza la co-consegna App IO su POSTAL non può fare fallback al body
del canale primario (sarebbe vuoto/non pertinente): la differenziazione
oggetto/testo App IO è forzata sempre per POSTAL (checkbox "Differenzia"
nascosta, campi sempre obbligatori nel wizard).

**Etichetta allegato dinamica per destinatario.** `AttachmentConfigEntry` ha
un campo opzionale `labelColumn`: se impostato, l'etichetta effettiva va letta
riga per riga da `recipient.extraData[labelColumn]` tramite
`resolveAttachmentLabel(entry, recipient)` (`attachment.service.ts`), MAI
leggendo `.label` direttamente — sono ~8 punti diversi (email/pec/app-io
strategy, notification.processor, protocollazione.processor, citizen.service,
campaigns.service preview/dettaglio) che costruiscono `attachmentLabels`: un
nuovo punto che dimentica di passare il `recipient` specifico produce
un'etichetta sempre fissa, ignorando silenziosamente la colonna scelta.

**Fallback legacy senza mappatura allegati esplicita.** Se una campagna non
ha né `channelConfig.attachments` né `allegatoKey` (campagne vecchie, o mai
configurate a step3), `resolveCustomAttachmentFilename()`
(`attachment.service.ts`) scansiona `extraData` e usa il primo valore che
termina in `.pdf`, con etichetta fissa "Documento principale.pdf"
(`processTemplate`, `template.helper.ts`). Qualunque UI che mostri "quali
allegati sono attesi" leggendo solo `channelConfig.attachments` (es.
`wizAttachments` nel wizard) deve replicare lo stesso fallback, altrimenti
mostra "nessun allegato" per campagne che in realtà ne inviano uno — bug
reale corretto nell'anteprima PDF di step6.

**Allegato obbligatorio per SEND e POSTAL — bloccato in UI e backend.**
Per questi due canali l'allegato È il contenuto notificato (atto legale /
lettera), non un corredo opzionale al body come per EMAIL/PEC/APP_IO. Il
wizard blocca "Procedi" allo Step3 senza almeno un allegato mappato;
`CampaignsService.launch()` ripete lo stesso controllo lato server (pattern
200 + `{blocked:true}`, vedi gotcha proxy sopra — mai eccezione non-2xx qui).

**`AttachmentService.generatePdfBuffer` non genera più un PDF segnaposto.**
Se nessun file custom risolve per l'indice richiesto (config assente o file
mancante su disco), lancia `NotFoundException` — niente più fallback silenzioso
con logo/dati generici che mascherava configurazioni rotte. Impatta anche
`public-download.controller.ts` (propaga come 404 al citizen) e i job
(`postal.strategy.ts`, `send-dispatch.service.ts`, `protocollazione.processor.ts`)
dove ora un allegato mancante fa fallire esplicitamente l'attempt invece di
spedire un documento fittizio.

