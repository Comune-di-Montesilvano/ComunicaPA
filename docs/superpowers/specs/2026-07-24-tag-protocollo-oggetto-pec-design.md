# Tag protocollo automatico nell'oggetto PEC in uscita

## Contesto

Quando una campagna ha `channelConfig.protocolla === true`, ogni destinatario
passa prima dalla coda `PROTOCOLLAZIONE` (`protocollazione.processor.ts`):
registra il documento sul webservice protocollo (`ProtocolloService.protocolla()`,
`apps/backend/src/protocollo/protocollo.service.ts`) usando come `oggetto`
il testo grezzo di `campaign.channelConfig.subject` (o `campaign.name` come
fallback) — non processato, non specifico per destinatario — poi scrive
`protocolNumber`/`protocolYear` sull'attempt e re-accoda il job sul canale
reale (`notification.processor.ts`).

Prima di richiamare `strategy.send()`, `notification.processor.ts` (riga 134-136)
imposta `(recipient as any).protocolNumber = "${numero}/${anno}"` (es.
`"47509/2026"`) SOLO se l'attempt ha già un protocollo scritto — quindi
sempre vero quando `protocolla === true`, dato l'ordine dei processor sopra.

`PecStrategy.send()` (`apps/backend/src/channels/pec/pec.strategy.ts`)
costruisce l'oggetto reale via `processTemplate(subjectTemplate, recipient, ...)`
— stesso codice sia per PEC come canale di campagna, sia per un destinatario
dirottato su PEC da INAD (override che scrive `attempt.channelType = 'PEC'`
a prescindere dal canale originario campagna) — un solo punto di modifica
copre entrambi i casi.

Il sistema esterno "protocollo TINN" aggancia automaticamente le ricevute di
accettazione/consegna leggendo un tag riconoscibile nell'oggetto della PEC
realmente recapitata: `[Protocollo N.ro <anno>-PROT-<numero>]`.

## Design

Modifica isolata in `PecStrategy.send()`, attiva solo quando
`campaign.channelConfig?.['protocolla'] === true`:

1. **Prima di `processTemplate`**: strip dall'oggetto (`subjectTemplate`, non
   dal body) di eventuali placeholder manuali ridondanti — stessi sinonimi
   già gestiti da `getVal()` in `template.helper.ts`
   (`numero_protocollo|numeroprotocollo|protocollo|protocol_number`, case
   insensitive, delimitatore `%%...%%`) — sostituiti con stringa vuota.
   Evita un doppione se l'operatore ha già inserito manualmente il
   placeholder nel template oggetto: il tag automatico lo rende ridondante.
   Nessuna modifica a `template.helper.ts` (resta invariato per body e altri
   canali/usi di `%%protocollo%%`).
2. **Dopo `processTemplate`**: se `(recipient as any).protocolNumber` è
   presente (formato `"numero/anno"`), append all'oggetto risolto:
   `` ` [Protocollo N.ro ${anno}-PROT-${numero}]` `` (split su `/` per
   ricomporre nell'ordine anno-prima richiesto dal tag).
3. **Se `protocolNumber` assente** nonostante `protocolla === true` (caso
   limite, es. race o dato incompleto): nessun tag aggiunto, l'invio prosegue
   comunque — un problema di formattazione dell'oggetto non deve mai
   bloccare la spedizione.

**Nessuna modifica** a:
- `protocollazione.processor.ts` / `ProtocolloService` — l'oggetto
  registrato sul webservice protocollo resta il testo grezzo del template,
  senza tag (comportamento attuale, confermato corretto: il tag è solo per
  l'oggetto della PEC realmente recapitata, non per la registrazione)
- `email.strategy.ts` / `postal.strategy.ts` / `send-dispatch.service.ts` —
  richiesta esplicitamente scoped a "PEC in uscita" (canale o dirottamento
  INAD), non ad altri canali anche quando `protocolla === true`
- `template.helper.ts` — nessun placeholder globale nuovo, solo strip
  mirato nell'oggetto PEC lato strategy

## Testing

`pec.strategy.spec.ts`, nuovi casi:
- `protocolla === true` + `recipient.protocolNumber = "47509/2026"` →
  oggetto finale termina con `[Protocollo N.ro 2026-PROT-47509]`
- `protocolla === true` + oggetto template contiene `%%protocollo%%` →
  placeholder rimosso, nessun doppione (solo il tag finale compare)
- `protocolla === true` + `recipient.protocolNumber` assente → oggetto
  invariato, nessuna eccezione, invio prosegue
- `protocolla` non impostato / `false` → comportamento invariato (nessun
  tag, nessuno strip)
