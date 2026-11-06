# Timeline del perfezionamento SEND — dettaglio notifica

Data: 2026-11-06

## Perché

Caso reale (2026-11-06): una notifica SEND è finita in irreperibilità totale. PN è passato a `UNREACHABLE` il 03/11/2026 e il dettaglio notifica mostra solo "Destinatario irreperibile" e "Nessuna consegna al destinatario". **Non c'è nessuna data di notifica per il destinatario**, né maturata né prevista. L'operatore non sa da quando decorrono i termini (pagamento, ricorso), quindi non sa quando l'atto potrà diventare definitivo.

In più, la nota attuale per l'irreperibile (`journey.ts` ~356, e la tabella in guida "Date di notifica e termini") dice "si è perfezionata 10 giorni dopo il deposito dell'avviso su SEND (art. 26, comma 7)". Il testo vigente dell'art. 26 D.L. 76/2020, letto su Normattiva il 2026-11-06, dice altro:
- **comma 7**: la notifica *dell'avviso di avvenuta ricezione* depositato in piattaforma si perfeziona il 10° giorno dopo il deposito;
- **comma 9, lett. b, n. 2**: per il destinatario la notificazione si perfeziona il 10° giorno dopo il perfezionamento della notificazione dell'avviso cartaceo;
- **n. 3**: in ogni caso, se è anteriore, vale la data in cui il destinatario accede al documento sulla piattaforma.

**Verifica su dato reale (2026-11-06).** La lettura "due decorrenze di 10 giorni in fila" (10 + 10) è stata controllata su PN con una GET in sola lettura su una notifica reale: `UNREACHABLE`/`COMPLETELY_UNREACHABLE` al 17/10 02:45:43Z, `SCHEDULE_REFINEMENT` con `details.schedulingDate` al 27/10 02:45:43Z, poi `REFINEMENT` ed `EFFECTIVE_DATE` il 27/10. PN perfeziona quindi la notifica per il destinatario a **deposito + 10 giorni** (termine unico, art. 26, c. 7). Il percorso irreperibile è `entity` → `deposited` → `recipient` (+10); non esiste una tappa intermedia "avviso perfezionato".

## Obiettivo

Nel riquadro dell'esito del dettaglio notifica (`NotificationVerdict`), **sempre per le notifiche SEND, qualunque esito abbiano**, compare una **piccola timeline orizzontale**. Mostra le tappe che portano alla data di notifica per il destinatario, con le date passate, le date future previste e il segnaposto "oggi".

Riferimento visivo approvato dall'utente: opzione **A**, "Quattro tappe con oggi". Mockup in `.superpowers/brainstorm/734-1793981119/content/timeline-perfezionamento.html`, che non è versionato. In sintesi:
- linea orizzontale con pallini;
- sopra ogni pallino la data in grassetto (gg/mm), sotto un'etichetta breve;
- pallini pieni per le tappe passate, vuoti per quelle future;
- tappa finale "Notificata per il destinatario" evidenziata;
- tratto colorato fino a oggi e marcatore "oggi gg/mm";
- tappa di esito negativo (deposito per irreperibile) con pallino rosso;
- sotto la linea, una nota breve sullo stato della data finale.

## Non-obiettivi

- Altri canali (PEC diretta, POSTAL, App IO, email): no. La raccomandata POSTAL è un possibile secondo passo, da progettare a parte (A/R semplice e atto giudiziario hanno regole diverse).
- Campagne e notifiche SEND annullate (`CANCELLED`): la timeline non compare.
- Nessun cambio a calcolo o significato della colonna "Notificata per il destinatario" (`sendLegalDateOf`), ai report CSV, al cruscotto legale.
- Festivi e sospensione feriale: niente slittamenti nel calcolo. La norma dice "decimo giorno successivo" e i termini processuali sono un tema separato, già spiegato in guida.

## Anti-obiettivi

- Mostrare come certa una data stimata: ogni data non ancora confermata da PN è etichettata come prevista.
- Contraddire PN: quando PN dà una data (programmata o effettiva), vince sempre sul nostro calcolo.
- Ripetere l'errore attuale di presentare il comma 7 come perfezionamento per il destinatario.

## Passo 0 — timeline PN completa (denylist)

Oggi `extractSendTimeline` è una whitelist: 11 categorie e 8 campi dei dettagli. Il resto della risposta PN (`SCHEDULE_REFINEMENT`, `REFINEMENT`, `COMPLETELY_UNREACHABLE`, `schedulingDate`, `attachments`, `legalFactId`, costi…) si perde a ogni poll. Ogni nuova funzione obbliga quindi a tornare a rileggere SEND. Decisione dell'utente (2026-11-06): **si conserva tutto tranne le PII**.

- Si tengono tutte le categorie. Ogni evento conserva i campi già normalizzati, così i consumatori esistenti restano invariati, e in più `details`: copia dei dettagli PN depurata.
- La depurazione è **ricorsiva** e toglie una lista chiusa di chiavi a qualunque profondità: `taxId`, `denomination`, `recipient`, `recipientId`, `delegateInfo`, più `detail` dentro ogni elemento di `refusalReasons` (PN può ripetere un codice fiscale); `errorCode` e gli altri campi restano.
- **Gli indirizzi si tengono** (`physicalAddress`, `digitalAddress`, `foundAddress`, righe dell'indirizzo cartaceo ecc.): sono dati del destinatario che l'ente già possiede e il primo è già mostrato in «Recapito». Decisione dell'utente (2026-11-06): l'operatore deve vedere l'indirizzo del secondo tentativo, che SEND può aver trovato diverso.
- I tipi stanno sia in `SendTimelineEvent`, backend e frontend, sia in `AttemptDetailDto`: `details?: Record<string, unknown>`.
- **Backfill una tantum**: `SendStatusSyncService.updateStatuses` ripesca anche gli attempt terminali la cui timeline è nel formato vecchio, cioè non vuota e con il primo evento senza `details`, oppure ha un evento analogico con `details` ma senza `physicalAddress` (timeline ripollate prima che gli indirizzi fossero tenuti). Dopo un poll hanno `details`, quindi escono dal ripescaggio da soli. Nessuna migration.
- Il percorso mostra «Inviata a: <indirizzo>» sulle spedizioni cartacee (`SEND_ANALOG_DOMICILE`, `SEND_SIMPLE_REGISTERED_LETTER`); le altre categorie restano invariate, perché `describeSendTimelineEvent` restituisce null per quelle che non conosce.

## Fonte delle date (in ordine di priorità)

1. **Data effettiva PN**: `sendLegalDateOf(sendStatusHistory)`, cioè la minima tra `VIEWED` ed `EFFECTIVE_DATE`. È la stessa data della colonna "Notificata per il destinatario": la timeline la mostra come tappa finale confermata.
2. **Data programmata da PN**: evento di timeline PN `SCHEDULE_REFINEMENT`, che porta la data in cui PN perfezionerà la notifica. Oggi `extractSendTimeline` (`apps/backend/src/channels/send/send-status-history.util.ts`, `SEND_TIMELINE_CATEGORIES`) non lo conserva.
   - Va aggiunto, insieme a `REFINEMENT` e alle categorie utili per le tappe intermedie: `COMPLETELY_UNREACHABLE`, `DIGITAL_SUCCESS_WORKFLOW`, `ANALOG_SUCCESS_WORKFLOW`, `NOTIFICATION_VIEWED`.
   - Si conserva solo la data di programmazione, mai indirizzi né dati del destinatario. Stesso principio già scritto sopra `SendTimelineEvent`.
   - **Primo passo dell'implementazione**: verificare su una risposta PN reale il nome del campo dei dettagli di `SCHEDULE_REFINEMENT` (atteso `schedulingDate`) e la presenza delle categorie elencate. Fonte: risposta salvata di un attempt SEND reale, o doc/OpenAPI PN. Se il campo non esiste o ha altro nome, adeguare. Se non è disponibile affatto, si usa solo il punto 3.
   - La timeline si ripopola al poll successivo di `SendStatusSyncService`, che sovrascrive la timeline intera: nessuna migration, la colonna `send_timeline` è già jsonb.
3. **Stima nostra** (ripiego), dalle regole del comma 9 lett. b, solo se mancano 1 e 2:
   - **digitale consegnato**: consegna nel domicilio digitale + 7 giorni. Se la consegna è dopo le 21:00 (ora italiana) si conta dal giorno successivo;
   - **digitale con casella satura, non valida o non attiva**: deposito dell'avviso di mancato recapito + 15 giorni;
   - **cartaceo consegnato**: nessuna stima. La data di perfezionamento dell'avviso cartaceo dipende da giacenza e compiuta giacenza (L. 890/1982): la tappa finale resta "in attesa di SEND", senza data;
   - **irreperibile totale**: deposito + 10 (notificata per il destinatario, art. 26 c. 7, verificato su PN).

   Giorni di calendario, data in fuso Europe/Rome. Un'apertura del destinatario (`VIEWED`) anteriore rende la data effettiva quella dell'apertura (punto 1).

## Tappe per percorso

Prima tappa sempre "**Notificata per l'ente**" = `sendEntityLegalDateOf` (stato `ACCEPTED`), già calcolata oggi. Ultima tappa sempre "**Notificata per il destinatario**".

| Percorso (riconosciuto da storico stati e timeline PN) | Tappe intermedie |
|---|---|
| In lavorazione, nessun esito di recapito | "In consegna", senza data o con la data di `DELIVERING` |
| Digitale consegnato | "Avviso consegnato al domicilio digitale" (`SEND_DIGITAL_FEEDBACK` OK / `DIGITAL_SUCCESS_WORKFLOW`) |
| Digitale fallito, mancato recapito depositato | "Avviso di mancato recapito depositato" (`DIGITAL_FAILURE_WORKFLOW`); poi segue il cartaceo se PN lo avvia |
| Cartaceo consegnato / compiuta giacenza | "Avviso cartaceo consegnato" (o "in giacenza"), da `SEND_ANALOG_FEEDBACK` / `ANALOG_SUCCESS_WORKFLOW` |
| Irreperibile totale | "Avviso depositato su SEND" (data di `UNREACHABLE` o `COMPLETELY_UNREACHABLE`, rosso); poi direttamente "Notificata per il destinatario" (+10) |
| Aperta dal destinatario | "Visualizzata su SEND" (`VIEWED`); se anteriore diventa la data finale; se successiva alla data finale non si mostra (irrilevante dopo il perfezionamento) |

Il raggruppamento esatto degli stati PN nei percorsi è lasciato al builder. Unico vincolo: ogni notifica SEND con IUN, non annullata né rifiutata (`CANCELLED`/`REFUSED` → nessuna timeline; tentativo fallito o senza IUN → nessuna timeline), cade in uno dei percorsi, con "in lavorazione" come ripiego.

## Nota sotto la timeline

- Data finale effettiva (punto 1): "Notificata per il destinatario il gg/mm/aaaa secondo SEND."
- Data programmata da PN (punto 2): "Prevista da SEND per il gg/mm/aaaa, prima se il destinatario apre la notifica."
- Stima nostra (punto 3): "Data stimata (art. 26, comma 9, D.L. 76/2020): si conferma con l'esito di SEND; prima se il destinatario apre la notifica."
- Nessuna data: "La data dipende dall'esito del recapito: la indicherà SEND."

La frase attuale "Destinatario irreperibile: … 10 giorni dopo il deposito (art. 26, comma 7)" va tolta o corretta: la timeline ne prende il posto. "Nessuna consegna al destinatario" e il link "Cosa fare" restano.

## Guida operatori

Stessa PR, data in testa aggiornata. In "Date di notifica e termini":
- correggere la riga "Destinatario irreperibile" della tabella: deposito dell'avviso su SEND, +10 giorni per il destinatario (comma 7), con link Normattiva;
- aggiungere una frase sulla timeline nel dettaglio notifica: le date passate, quelle previste, e il fatto che vale sempre la data di SEND.

I titoli esistenti non vanno rinominati (`check-guida.mjs`).

## Test

- Unit sulla funzione che costruisce le tappe, pura e testabile nel frontend o nel backend (scelta del builder). Un caso per ogni percorso della tabella, più:
  - irreperibile con `SCHEDULE_REFINEMENT`;
  - irreperibile senza `SCHEDULE_REFINEMENT` (stima 03/11 → 13/11);
  - digitale consegnato alle 21:30 (conteggio dal giorno successivo);
  - apertura anteriore alla data prevista;
  - `CANCELLED` (nessuna timeline).
- Test con fusi orari UTC ed Europe/Rome, perché la CI gira in UTC (CLAUDE.md).
- `extractSendTimeline`: le nuove categorie vengono conservate con la data di programmazione e senza campi di indirizzo.

## Decisioni dopo la revisione (2026-11-06)

- **Calcolo nel backend.** Il frontend admin non ha un runner di test (`pnpm test` = solo `check-guida`). Una funzione pura `buildSendPerfection(history, timeline, now)` in `apps/backend/src/campaigns/send-perfection.util.ts`, testata con Vitest, è esposta nel DTO del dettaglio come `AttemptDetailDto.sendPerfection`. Il frontend la disegna e basta.
- **Tappa con data stimata già passata ma non confermata da PN**: resta "prevista", pallino vuoto con contorno, etichetta "(prevista)". Pieno solo ciò che è accaduto secondo PN.
- **Più `SCHEDULE_REFINEMENT`**: vale l'ultimo per `at`.
- **Regola delle 21:00**: si applica solo alla consegna digitale (+7). La soglia è esclusiva, quindi alle 21:00:00 vale ancora il giorno stesso.
- **`REFINEMENT`** (in PN, "perfezionamento per decorrenza termini") dà la data finale per il destinatario, non una tappa intermedia. La data finale effettiva è `sendLegalDateOf(history)`; se manca, vale `REFINEMENT.at`.
- **Irreperibile già a `EFFECTIVE_DATE`**: la data finale è quella di PN. Non c'è una tappa intermedia: la tappa finale è deposito +10 e resta "(prevista)" finché non arriva la data finale da PN, poi diventa piena.
- **Notifiche vecchie**: il backfill del Passo 0 le ripopola. Se PN non ha `SCHEDULE_REFINEMENT`, vale la stima con l'etichetta "Data stimata". È accettato come risultato da mostrare.
- **Verifica `schedulingDate`**: non c'è una risposta PN salvata. Il codice legge `details.schedulingDate`, il nome atteso dalla doc PN, e se il campo manca ripiega sulla stima. Dopo il deploy del Passo 0, i `details` salvati permettono di verificare il nome direttamente nel DB.

## Lasciato al builder

- Componente, nomi e CSS, nello stile esistente di `notification-detail.css`. Su schermi stretti la timeline può andare a capo o in verticale.
- Testi brevi delle etichette, in italiano e nel tono della UI esistente.

---

# Filtri della lista campagne e della ricerca notifiche

Richiesta dell'utente (2026-11-06): più filtri, separare lo stato dalla ricerca testuale, aggiungere l'autore, 20 elementi per pagina. Oggi "è confusionario".

## Lista campagne (`App.tsx`, `getFilteredCampaigns` e barra filtri ~9835)

- Filtro tutto lato client, come oggi: `GET admin/campaigns` restituisce già tutte le campagne visibili, con `createdBy` e `createdByDisplayName`.
- **Ricerca testuale**: cerca solo nome, descrizione e id. Toglie `status` e `channelType` dal match testuale; il placeholder diventa "Cerca per nome o ID…".
- **Nuovo select "Stato"**: "Tutti" più gli stati presenti (`draft`, `queued`, `checking_inad`, `running`, `completed`, `failed`, `cancelled`), con etichette da `STATUS_META`. Per un aggregato multicanale si filtra sullo stato aggregato già calcolato (il peggiore).
- **Nuovo select "Autore"**: "Tutti" più gli autori distinti delle campagne caricate (`createdByDisplayName || createdBy`), in ordine alfabetico. Si filtra su `createdBy`.
- Restano "Tipo campagna" e le date.
- Il "Reset" azzera anche i due nuovi filtri, e ogni cambio di filtro riporta a pagina 1.
- `CAMPAIGN_PAGE_SIZE` = 20.

## Ricerca notifiche (vista `notifiche-ricerca`)

- **Backend**: nuovo filtro `createdBy` su `GET admin/notifications-search`, `campaign.createdBy = :createdBy` (uguaglianza esatta). La visibilità resta quella di `visibleCampaignSql`.
- **Frontend**: nuovo select "Autore" tra "Campagna" e "Canale", con le opzioni da `GET admin/operators` (username e displayName, come in `SignaturePanel`) caricate all'apertura della vista. "Azzera" lo azzera.
- `SEARCH_PAGE_SIZE` = 20.
- Guida: aggiornare le sezioni sulla lista campagne e sulla ricerca notifiche con i nuovi filtri, la data in testa nella stessa PR, senza rinominare i titoli.
