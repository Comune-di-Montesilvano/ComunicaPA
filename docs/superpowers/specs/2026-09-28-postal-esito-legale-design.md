# POSTAL — Esito legale in "Stato Documento" e Stato notifica derivato

Data: 2026-09-28 · Stato: da approvare

## Obiettivo

"Stato Documento" delle campagne POSTAL deve rappresentare il **valore
legale** della notifica, non il ciclo di vita del documento su GlobalCom.
"Consegnato" comprende ogni caso che per legge equivale a consegna, con la
**data legale** (valore probatorio) accanto. Il report sintetico legale è un
lavoro successivo, fuori scope.

Solo raccomandate con AR (`hasPostalArTracking(campaign)`). SEND resta
com'è (eventuali correzioni in un secondo momento).

## Stato attuale (verificato sul codice e sui dati)

- "Stato Documento" = `notification_attempts.postal_status` grezzo
  (Accettato, Confermato, Consegnato, NonConsegnato, Errore…) più i bucket
  `DirottatoAPec` e `FAILED` (`getPostalStatusBreakdown`, opzioni filtro
  `deliveryStatuses`, colonna tabella, grafico, barra esito, CSV).
- Il motivo del recapito è in `postal_delivery_status` (`StatoConsegna`
  GlobalCom), la data in `postal_delivery_date` (`DataConsegna`).
- Compiuta giacenza e rifiuto arrivano da GlobalCom come `NonConsegnato`
  con `StatoConsegna` `Compiuta Giacenza` / `Invio Rifiutato`: oggi contati
  come non consegnati. Il tracking Poste li vede solo come "restituita al
  mittente" (`flagRitorno`), senza motivo — verificato dal vivo su
  570202746797 (giacenza dal 08/08, `DataConsegna` GlobalCom 08/09) e
  570202727476 (rifiuto).
- Le etichette frontend `Rifiuto`/`Giacenza` non corrispondono ai valori
  reali (`Invio Rifiutato`/`Compiuta Giacenza`): mostrati come testo grezzo.
- Un `Errore` GlobalCom dopo l'accettazione (es. `1327` "La nazione TUNISIA
  si trova in una zona non ammessa") lascia tentativo e destinatario `sent`:
  "Stato notifica" dice Inviato.

Valori reali in produzione (conteggio per coppia `postal_status` /
`postal_delivery_status`), base della mappatura sotto:
Consegnato (Consegnato, a Domicilio, a Sportello, in Digitale);
NonConsegnato (Compiuta Giacenza, Invio Rifiutato, Destinatario deceduto /
irreperibile / sconosciuto / trasferito, Indirizzo errato o inesatto /
insufficiente / sconosciuto); Confermato (Accettato, Accettato online, In
giacenza, Inesitato, Smarrito, vuoto); AppIoSostituito; Eliminato; Errore;
nessuno stato.

## Esito legale

Calcolato per destinatario sull'ultimo tentativo POSTAL, in quest'ordine
(primo che si applica):

| # | Condizione | Esito | Motivo | Data legale |
|---|---|---|---|---|
| 1 | destinatario dirottato INAD (`inad_check.diverted`) | Consegnato | Via PEC | invio PEC (`sent_at` del tentativo PEC) |
| 2 | `postal_status = AppIoSostituito` | Senza valore legale | Solo App IO | — |
| 3 | campagna senza AR | Senza AR | — | — |
| 4 | tentativo `FAILED` | Non consegnato | Invio fallito | — |
| 5 | `postal_status = Errore` | Non consegnato | codice/descrizione GlobalCom | — |
| 6 | `postal_delivery_status` in CONSEGNATO | Consegnato | valore GlobalCom | `postal_delivery_date` |
| 7 | verifica Poste `delivered` | Consegnato | Verifica Poste | `outcome_at` Poste |
| 8 | `postal_delivery_status` in NON_CONSEGNATO | Non consegnato | valore GlobalCom | — |
| 9 | `postal_status = Eliminato` | Non classificato | stato GlobalCom grezzo | — |
| 10 | altrimenti | In corso | valore GlobalCom se presente | — |

- CONSEGNATO: `Consegnato`, `Consegnato a Domicilio`, `Consegnato a
  Sportello`, `Consegnato in Digitale`, `Compiuta Giacenza`, `Invio
  Rifiutato`.
- NON_CONSEGNATO: `Destinatario deceduto`, `Destinatario irreperibile`,
  `Destinatario sconosciuto`, `Destinatario trasferito`, `Indirizzo errato
  o inesatto`, `Indirizzo insufficiente`, `Indirizzo sconosciuto`,
  `Smarrito`, `Inesitato`.
- Qualunque valore non elencato cade in "In corso" (mai Consegnato per
  default). `In giacenza`, `Accettato`, `Accettato online` = In corso.
- GlobalCom dà il motivo; Poste può solo promuovere a Consegnato (riga 7
  dopo la 6: una Compiuta Giacenza resta tale anche se Poste dice
  "restituita"; un "Indirizzo errato" con consegna Poste diventa
  Consegnato, come l'attuale discrepanza). Poste `returned` non cambia mai
  l'esito.
- Eliminato: fuori scope, nessuna classificazione legale; resta visibile
  col suo stato grezzo.

Tutto è derivato in lettura: nessuna colonna nuova, nessuna migration,
nessuna scrittura. Un cambio di stato GlobalCom o Poste si riflette da solo
al giro successivo.

## Stato notifica derivato

Per le campagne POSTAL, un destinatario `sent` il cui ultimo tentativo
POSTAL è in `Errore` GlobalCom è mostrato **Fallito** (stesso schema dello
stato derivato "Letto" di v1.8.7). `recipient.status` resta `sent`: continua
a governare completamento campagna, retry e statistiche. Se GlobalCom
corregge o riaccoda, lo stato torna da solo. Si applica a opzioni filtro,
filtro `status`, righe della tabella destinatari e barra esito.

## Architettura

Un solo modulo backend, `campaigns/postal-legal-outcome.util.ts`:

- tabelle CONSEGNATO / NON_CONSEGNATO e codici esito
  (`delivered`, `not_delivered`, `in_progress`, `no_legal_value`,
  `no_ar`, `unclassified`);
- `postalLegalOutcomeSql(alias…)`: espressione SQL `CASE` generata dalle
  stesse tabelle, usata per conteggi, filtro e pagina destinatari (niente
  logica duplicata a mano nelle query);
- `postalLegalOutcome(input)`: stessa regola in TypeScript per CSV e
  dettaglio notifica;
- test che verificano la stessa classificazione per ogni riga della tabella
  sopra, sia in TS sia in SQL (query su Postgres reale in dev, come da
  gotcha TypeORM già noti).

Consumatori aggiornati:

- `getPostalStatusBreakdown` → breakdown per esito legale (grafico "Stato
  Documento" e barra esito);
- opzioni filtro `deliveryStatuses` e filtro `deliveryStatus` della pagina
  destinatari per POSTAL → valori esito legale;
- righe pagina destinatari → `legalOutcome`, `legalOutcomeReason`,
  `legalOutcomeAt`;
- `postal-report-csv.util.ts` → "Stato Documento" = esito legale, "Data
  Stato" = data legale, nuova colonna "Stato GlobalCom" con lo stato grezzo;
- dettaglio notifica → esito legale in evidenza, stato GlobalCom invariato
  sotto;
- frontend: registro etichette/colori esito legale in un solo punto
  (stesso principio di `POSTAL_STATUS_META`), tooltip con stato GlobalCom
  grezzo e data legale; etichette `POSTAL_DELIVERY_STATUS_META` allineate ai
  valori reali ("Recapito Poste" resta com'è per il resto).

"Recapito Poste" (`postal_delivery_status`), i filtri rapidi Discrepanze /
Controllati su Poste e la verifica Poste restano invariati.

## Fuori scope

Report sintetico legale; SEND; Eliminato/riaccodamenti; tracciamento delle
mancate consegne PEC; external API (`getExternalDeliveryStatus`).

## Test

- unit: `postalLegalOutcome` su ogni riga/valore delle tabelle, precedenze
  (dirottato, Compiuta Giacenza + Poste returned, Indirizzo errato + Poste
  delivered, Errore, valore sconosciuto);
- SQL: stessa matrice contro Postgres dev;
- breakdown, filtri e CSV: spec esistenti aggiornate;
- stato notifica derivato: `Errore` → Fallito, `recipient.status` invariato;
- verifica in browser su campagna POSTAL dev.
