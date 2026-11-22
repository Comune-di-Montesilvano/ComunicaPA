# Verifica Domicili: errore "impresa cessata" dal Registro Imprese

Data: 2026-11-21 — dimensione: modifica piccola.

## Perché

Nella Verifica Domicili massiva un'impresa cessata oggi è invisibile: se cessata
da oltre un anno il domicilio esce vuoto senza spiegazione, se da meno di un anno
la PEC compare senza alcun avviso. L'operatore deve vedere la cessazione e
decidere lui cosa fare della riga.

## Obiettivi

- Colonna `errori` dell'aggregato: per le **partite IVA** di imprese con
  `stato-impresa` valorizzato, errore con stato, data e causale.
- Riepilogo "Verifica completata": numero di imprese cessate.
- Guida operatori aggiornata (data in testa, elenco errori in "Verifica Domicili").

## Non obiettivi

- Persone fisiche (CF di 16 caratteri): nessun cambiamento, anche se il
  Registro Imprese ha una ditta individuale cessata.
- Logica PEC invariata: `isPecStillUsable` (PEC valida se cessata da meno di un
  anno) resta com'è; cessata da poco ⇒ PEC in `domicilio_digitale` **e** errore.
- Campagne (`VERIFY_PIVA_CAMPAIGN_JOB_NAME`) e Verifica Anagrafica: invariate.
- Compatibilità con job già esistenti: l'utente li elimina prima/dopo il deploy.

## Approcci considerati

1. Nuova colonna jsonb `registro_imprese_ceased_map` — isolata, ma migration e
   un campo in più.
2. **Scelto dall'utente:** `registro_imprese_found_map` da `Record<string, boolean>`
   a `Record<string, RegistroImpreseOutcome>`. Colonna già jsonb: niente
   migration. Formati misti coi job vecchi non gestiti (job vecchi eliminati).
3. Ricalcolo al report — scartato: XML grezzo non salvato, servirebbe
   reinterrogare Registro Imprese (5 req/s).

## Design

- `RegistroImpreseDettaglioResult` espone già `data.sede.statoImpresa`,
  `dtCancellazione`, `causaleCessazione`: nessuna modifica al service.
- Tipo nuovo (entity + CSV util):
  `{ found: boolean; stato?: string; dtCancellazione?: string; causale?: string }`;
  i campi di cessazione solo se `stato` presente. Chiave assente = verifica non
  riuscita (semantica invariata).
- `processAdHocVerify`: scrive l'oggetto al posto del booleano (stessa UPDATE
  con concat jsonb).
- `buildDomicileVerificationCsvs`, ramo `piva`: `found === false` → errore di
  oggi; `found` con `stato` → `impresa cessata nel Registro Imprese (stato:
  CANCELLATA, dal 12/03/2019, causale: …)`, parti mancanti omesse.
- Stato job (`getStatus`): `registroImpreseCeasedCount` = chiavi partita IVA
  (`checkTaxId(...).kind === 'piva'`) con `stato`, calcolato dalla mappa.
- Frontend admin: "…trovati su Registro Imprese, di cui N cessate" se N > 0.

## Lasciato al builder

- Testo esatto del contatore UI e posizionamento nella guida.
- Test: CSV util (cessata con/ senza data/causale, cessata con PEC, CF fisico
  cessato senza errore), processor (oggetto scritto), conteggio.
