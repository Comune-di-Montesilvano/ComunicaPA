# ComunicaPA – Guida per gli operatori

_Ultimo aggiornamento: 2026-11-06_

## Cos'è e chi lo usa

ComunicaPA è il portale con cui l'Ente invia comunicazioni ufficiali a cittadini e imprese (avvisi TARI, notifiche, sanzioni) su più canali: Email, PEC, App IO, SEND e Posta cartacea. Lo usano gli uffici che devono spedire comunicazioni, singole o massive, e chi ha bisogno di sapere se un cittadino o un'impresa ha un domicilio digitale.

Ogni invio resta tracciato: stato di consegna, errori, costi e report si consultano in qualsiasi momento dal dettaglio della campagna.

## Accesso

- **Indirizzo**: il portale operatori dell'Ente (il link è nella plancia dei dipendenti).
- **Credenziali**: utente e password di dominio, cioè gli stessi con cui accedi al PC. Nella pagina di accesso premi **Accedi con Active Directory**.
- **Ruoli**: gli operatori usano tutte le funzioni di invio e verifica. Gli amministratori vedono anche la voce **Impostazioni**.
- **Posta cartacea**: il canale Posta è riservato agli amministratori e agli operatori abilitati (vedi «Non vedo il canale Posta nel wizard»).

## Operazioni frequenti

### Verificare anagrafica e domicilio digitale

È la funzione più usata e non richiede di inviare nulla.

1. Apri **Verifica Anagrafica** dal menu.
2. Inserisci un Codice Fiscale (16 caratteri) o una Partita IVA (11 cifre).
3. Leggi in un'unica scheda i dati anagrafici, il domicilio digitale (INAD) e, per le imprese, l'estratto del Registro Imprese (vedi «Consultare la scheda di un'impresa»).

Casi particolari:

- **Imprese**: la ricerca avviene sempre per Codice Fiscale. Per la maggior parte delle imprese coincide con la Partita IVA, ma non sempre (enti pubblici, cooperative sociali).
- **Non conosci il Codice Fiscale dell'impresa**: usa il link **Non hai il codice fiscale?** e cerca per denominazione su Registro Imprese.
- **Impresa individuale**: il suo Codice Fiscale ha lo stesso formato di quello di una persona. Se la ricerca trova il soggetto sbagliato, spunta **Forza ricerca come impresa**.
- **Impresa cessata**: la scheda mostra in alto a destra un'etichetta con data e causale della cessazione.
- **Persona senza Codice Fiscale**: con cognome, nome, sesso, data e comune di nascita puoi fare una ricerca ANPR per anagrafica dallo stesso pannello. Serve indicare anche il motivo della ricerca.

### Consultare la scheda di un'impresa

Cercando un'impresa in **Verifica Anagrafica**, il riquadro **Registro Imprese** mostra un estratto dei dati camerali, simile a una visura. In alto a destra c'è lo stato: **ATTIVA**, oppure lo stato reale con data e causale della cancellazione.

Sempre visibili:

- denominazione e forma giuridica;
- CF/P.IVA, numero REA con la Camera di Commercio, indirizzo della sede;
- PEC, con il bottone per copiarla;
- data di costituzione e di iscrizione al Registro Imprese.

Le altre informazioni sono in riquadri da aprire con un clic:

| Riquadro | Contenuto |
| --- | --- |
| Attività | Attività prevalente, esercitata e secondaria; elenco dei codici ATECO con descrizione e importanza |
| Amministratori e cariche | Persone con cariche e, aprendo **Poteri**, i poteri conferiti; la stella indica il legale rappresentante (es. il titolare) |
| Localizzazioni / unità locali | Sede e unità locali con indirizzo, attività svolta e data di apertura |
| Soci | Soci con codice fiscale e diritto (es. proprietà) |
| Assetto societario e patrimonio | Durata della società, primo esercizio, sistema di amministrazione, collegio sindacale, controllo contabile, capitale sociale deliberato, sottoscritto e versato |
| Altri dati | Fonte, tipo di soggetto e di impresa, data di inizio attività |

I codici fiscali di amministratori e soci sono cliccabili: aprono la loro scheda per proseguire la ricerca. Un riquadro manca solo se quel dato non esiste per l'impresa (es. i soci di una ditta individuale).

L'estratto serve per consultazione interna e non sostituisce una visura camerale ufficiale.

### Inviare una comunicazione a pochi destinatari

1. Apri **Invio Manuale** dal menu.
2. **Dettagli & Destinatario**: inserisci a mano uno o più destinatari. Ogni riga può avere un canale diverso (es. una PEC e due App IO): il sistema crea una campagna per canale e le mostra insieme nella lista come un unico invio.
3. **Template**: scrivi oggetto e testo, se il canale li prevede.
4. **Anteprima e Invio**: controlla l'anteprima e lancia l'invio.

Prima di un invio manuale verifica il domicilio digitale da **Verifica Anagrafica**: qui il dirottamento automatico su PEC non si applica.

### Lanciare un invio massivo da file CSV

1. Apri **Invio Massivo** dal menu.
2. **Dettagli & Canale**: dai un nome alla campagna e scegli il canale. Un invio massivo usa un solo canale.
3. **Caricamento File**: carica il CSV dei destinatari.
4. **Mappatura & Validazione**: indica quale colonna contiene codice fiscale, nome, email o PEC, allegato. Le righe con errori sono elencate con il motivo.
5. **Template & Anteprima**: scrivi oggetto e testo, con i segnaposto se servono (vedi sotto).
6. **Upload Allegati**: carica gli allegati, anche in un unico file ZIP.
7. **Anteprima e Invio**: controlla l'anteprima destinatario per destinatario. Puoi fare un **Invio di prova** a un tuo indirizzo prima del lancio definitivo.

Dopo il lancio lo stato si segue dal dettaglio della campagna (vedi «Seguire lo stato di una campagna»).

### Personalizzare oggetto e testo con i segnaposto

Nell'oggetto e nel testo puoi inserire segnaposto che vengono sostituiti, destinatario per destinatario, con il suo valore. Il formato usa sempre il doppio percento: `%%nome_segnaposto%%`. Un `%` singolo nel testo (es. "sconto del 60%") resta com'è.

- Sempre disponibili: `%%nominativo%%`, `%%codice_fiscale%%`.
- Con allegati: `%%elenco_allegati%%` oppure `%%allegato1%%`, `%%allegato2%%` e così via. Se ci sono allegati, il testo deve contenere `%%elenco_allegati%%` oppure tutti i singoli `%%allegatoN%%`, altrimenti il destinatario non può scaricarli.
- Con la protocollazione: `%%numero_protocollo%%`.
- Con pagoPA: numero avviso, importo e scadenza.
- Nell'invio massivo: qualsiasi colonna del file non usata per CF, nome o email, scritta come `%%NomeColonna%%`, esattamente come nell'intestazione.

L'editor mostra sempre l'elenco dei segnaposto disponibili.

Se nella mappatura colleghi una colonna del CSV all'**Oggetto**, l'oggetto scritto nel wizard viene ignorato e vale quello della colonna, riga per riga.

### Convertire un tracciato Maggioli in CSV

**Arricchimento Tracciati** trasforma un tracciato Maggioli (CSV + PDF, es. avvisi TARI) in un CSV pronto per l'invio massivo.

1. Apri **Arricchimento Tracciati** e carica lo ZIP. Se il file è troppo grande puoi caricarlo in più parti: i pezzi vengono uniti in un unico lavoro.
2. Il sistema legge da ogni PDF l'indirizzo postale e i dati pagoPA (numero avviso, importo, scadenza, anche con più rate), dal codice a barre o dal QR.
3. Le righe che non si possono leggere in automatico (indirizzo mancante, QR illeggibile) compaiono come avviso: correggile a mano, una per una, senza ricaricare tutto.
4. A lavoro completato premi **Crea bozza campagna**: si apre il wizard di invio massivo con il CSV già caricato.

Lo ZIP con i PDF e **Crea bozza campagna** sono riservati a chi ha caricato il tracciato e agli amministratori. Se la bozza la crea un amministratore, risulta comunque creata da chi ha caricato il tracciato.

### Seguire lo stato di una campagna

1. Apri **Lista Campagne** e scegli la campagna.
2. Il dettaglio mostra lo stato di ogni destinatario (In coda, Inviato, Letto, Fallito…) e si aggiorna da solo mentre l'invio è in corso.
3. Per ogni destinatario si vede il **canale effettivo**: per il dirottamento su domicilio digitale può essere diverso da quello della campagna.
4. Il widget **Costo Campagna** mostra il costo di SEND e Posta. Dal dettaglio scarichi i report in CSV.
5. Nelle campagne SEND non compaiono i dati sui documenti scaricati: il destinatario apre la notifica su SEND (app IO, sito di SEND o punto di ritiro), non da ComunicaPA. Per sapere se l'ha letta guarda lo stato SEND **Letta dal destinatario**.

### Cercare una singola notifica

Apri **Ricerca Notifiche** e cerca per codice fiscale, nome, email, PEC o IUN. Funziona anche a distanza di tempo dall'invio. Il nome della campagna, nei risultati e nel dettaglio della notifica, apre la campagna. I filtri permettono, ad esempio, di vedere solo le notifiche lette o quelle restituite al mittente.

Una notifica ha due date, una per ciascuna parte (scissione degli effetti; per SEND art. 26, comma 9, D.L. 76/2020):

- **Notificata per l'ente** (solo SEND): il giorno in cui SEND mette il documento a disposizione, cioè la presa in carico. Da quel momento l'ente non incorre in decadenze e la prescrizione è interrotta (comma 10), anche se il destinatario riceve o legge la notifica dopo. Fa fede l'**attestazione «notifica presa in carico»** tra i Documenti SEND.
- **Notificata per il destinatario**: per SEND la prima tra la lettura della notifica e il perfezionamento per decorrenza dei termini; per le raccomandate la consegna o la compiuta giacenza. **Da questa data decorrono i termini del destinatario**: pagamento, ricorso, adempimento (per esempio i 90 giorni per demolire di un'ordinanza). Non usare la data per l'ente per contare questi termini.

Le colonne con questi nomi compaiono nell'elenco destinatari della campagna e nei report CSV, la data per l'ente anche nel dettaglio della notifica. Come si contano i termini, con esempi: [Date di notifica e termini](#date-di-notifica-e-termini).

Per una notifica SEND il **Percorso** del dettaglio riporta ogni cambio di stato con la sua data (accettata, in consegna, consegnata, letta, perfezionata) e i passaggi registrati da SEND: avviso di cortesia, invio al domicilio digitale, affidamento della raccomandata al recapitista con il tipo di raccomandata (è il momento in cui nasce il numero di raccomandata: stampa e imbustamento arrivano dopo, come «Stampata e imbustata»), avanzamenti del recapitista (avviso di giacenza, giacenza, esito con il codice del recapitista), ritiro da parte del destinatario presso un punto di ritiro SEND. I passaggi arrivano con l'aggiornamento automatico dello stato, ogni pochi minuti. Per le raccomandate il percorso riporta il numero della raccomandata (con il link **Traccia su poste.it** quando il numero è in formato Poste) e, quando il recapitista è Poste Italiane, anche i movimenti del tracking di Poste (presa in carico, lavorazione, disponibilità all'ufficio postale, esito), controllati una volta al giorno finché SEND la dà in consegna. Il tasto **Verifica ora su Poste** del dettaglio forza il controllo (al massimo una volta ogni 23 ore per notifica). SEND non indica il recapitista: un numero in formato diverso da quello di Poste viene indicato come recapitista diverso da Poste Italiane e non viene cercato su poste.it. Se SEND dichiara il destinatario **irreperibile** (nessun indirizzo valido, anche dopo il secondo tentativo), deposita l'avviso sulla piattaforma e la notifica si perfeziona 10 giorni dopo (art. 26, comma 7, D.L. 76/2020): la data legale è valida, ma il destinatario non l'ha ricevuta, e il dettaglio lo indica sotto lo stato. L'esito che conta resta quello di SEND: se Poste dà la raccomandata già consegnata o restituita mentre SEND la dà ancora in consegna, il dettaglio lo segnala come **Esiti diversi**. Vuol dire che il recapitista non ha ancora trasmesso l'esito a SEND: se la situazione resta ferma, apri una segnalazione all'assistenza SEND indicando IUN, numero della raccomandata e la data di consegna di Poste.

Per una notifica SEND, nel dettaglio apri **Documenti SEND** e premi **Carica documenti** per scaricare i documenti dalla piattaforma:

- le **attestazioni opponibili a terzi**: notifica presa in carico, avvenuto accesso (quando il destinatario legge la notifica), notifica digitale, mancato recapito;
- l'**avviso di avvenuta ricezione (AAR)**: nonostante il nome non prova che il destinatario abbia ricevuto la notifica, lo avvisa che c'è una notifica da consultare, con il codice QR per aprirla su SEND;
- per l'invio cartaceo: la **copia conforme dell'avviso spedito**, prodotta quando la raccomandata viene stampata e non è una prova di consegna; la **cartolina AR firmata**, che prova la consegna; il **plico restituito**, se il destinatario è irreperibile.

Il perfezionamento per decorrenza dei termini non genera un documento: la data compare nel percorso della notifica.

Nel portale cittadini una notifica SEND mostra solo lo stato e il link per aprirla su SEND (lo stesso del codice QR dell'avviso, o la pagina di accesso di SEND se il codice non è leggibile): documenti e attestazioni con valore legale si consultano solo lì. SEND mostra i documenti per 120 giorni dalla data in cui la notifica assume valore legale (avviso e attestazioni per 10 anni): passato quel periodo il portale cittadini offre la copia del documento inviato, indicata come copia di cortesia senza valore legale, con la data da cui decorrono i termini.

### Gestire le notifiche senza esito legale

In **Dashboard** il riquadro **Notifiche senza esito legale** elenca, per campagna, le notifiche SEND senza perfezionamento per il destinatario e le raccomandate con ricevuta di ritorno (o atti giudiziari) senza data legale di notifica: quelle con esito bloccante non l'avranno mai, le altre sono ferme senza esito da almeno 45 giorni. Ogni operatore vede le campagne che ha creato; gli amministratori le vedono tutte.

Le notifiche segnalate sono di due tipi:

- **Esito bloccante**: la notifica non andrà a buon fine, ad esempio destinatario deceduto o sconosciuto, indirizzo errato, notifica rifiutata o annullata da SEND. Compare subito.
- **Ferma da almeno 45 giorni**: dopo 45 giorni dal primo invio non c'è ancora una data legale. Per SEND il motivo distingue due casi:
  - **notificata per l'ente, non perfezionata per il destinatario**: il Comune è a posto (niente decadenza, prescrizione interrotta), ma per il cittadino i termini di pagamento e ricorso non sono partiti, quindi l'atto non può diventare definitivo né passare alla riscossione coattiva. Di solito il recapitista non ha trasmesso l'esito: apri una segnalazione all'assistenza SEND;
  - **non ancora messa a disposizione su SEND**: manca anche la data legale per l'ente, va verificata subito.

Per un esito bloccante (destinatario sconosciuto, trasferito, irreperibile, notifica rifiutata o restituita) vedi [Notifica non consegnata o destinatario irreperibile](#notifica-non-consegnata-o-destinatario-irreperibile).

1. Premi sulla campagna per aprire l'elenco delle notifiche.
2. Seleziona le notifiche e scegli:
   - **Presa visione**, per confermare di averle viste: escono dall'elenco;
   - **Posticipa**, solo per le notifiche ferme, di 15, 30 o 45 giorni o fino a una data a scelta: ricompaiono alla scadenza se sono ancora senza esito.
3. Puoi aggiungere una nota, ad esempio come hai proceduto. Ogni azione resta registrata con nome e data.

Se una notifica già presa in visione come ferma riceve in seguito un esito bloccante, ricompare. Premi sul nome del destinatario per aprire il dettaglio della notifica.

### Verificare i domicili digitali di un elenco

**Verifica Domicili Digitali** controlla un elenco intero senza inviare nulla.

1. Carica un file CSV e indica se ha una riga di intestazione.
2. Scegli la colonna **Codice Fiscale / Partita IVA** e il servizio App IO da usare per la verifica.
3. Premi **Avvia verifica**. Al termine vedi quanti soggetti sono su INAD e quanti su App IO.

Nello **Storico verifiche** vedi solo le verifiche che hai caricato tu (un amministratore le vede tutte, con la colonna **Operatore**). Con il cestino elimini una verifica conclusa: il file caricato e i risultati vengono cancellati definitivamente. Una verifica ancora in corso non si può eliminare.

### Gestire i template

Dalla voce **Template** salvi oggetti e testi da riusare negli invii. Un template email può essere collegato a un template App IO «gemello», usato per la notifica App IO abbinata.

### Firmare gli allegati SEND

Se la verifica firma segnala allegati non firmati validamente:

- **Invio massivo, Passo 6:** nel riquadro arancione scegli
  - **Firma con Aruba**: inserisci utente e password della firma remota, genera l'OTP e premi **Firma**. Un solo OTP firma tutti i file; al termine la verifica riparte da sola.
  - **Scarica ZIP da firmare**: firma i PDF con il tuo programma (firma PAdES, il file resta un PDF), poi **Carica firmati** con lo ZIP o il singolo PDF. I nomi possono restare uguali o avere il suffisso `-signed` / `_firmato`.
- **Invio Manuale:** se l'allegato non è firmato compare la scelta **Firma con Aruba**, **Invia comunque** o **Annulla**. Dopo la firma l'invio prosegue da solo.

La firma con Aruba compare solo se attivata in **Impostazioni → Firma remota (Aruba)**.

Gli allegati li firma chi ha creato la campagna, un amministratore o il **firmatario indicato** (ad esempio il dirigente che firma la campagna preparata dall'ufficio). Avviare la campagna, inviare il test, annullarla o eliminarla resta invece a chi l'ha creata o a un amministratore.

### Indicare il firmatario di una campagna SEND

Se gli allegati li firma un collega (di solito il dirigente), chi ha creato la campagna lo indica prima di chiedergli la firma:

1. Apri la bozza SEND e vai al **Passo 6**.
2. Nel riquadro della verifica firma scegli il collega nel campo **Firmatario**. La scelta si salva subito.
3. Il firmatario trova la bozza nella sua **Lista Campagne** e può aprire gli allegati, scaricare lo ZIP, firmare con Aruba e caricare i firmati.

Il firmatario si può cambiare o togliere (**Nessun firmatario**) finché la campagna è in bozza, ma non mentre è in corso una firma con Aruba. Lo possono scegliere solo chi ha creato la campagna e gli amministratori: gli altri vedono solo il nome del firmatario.

Nell'elenco compaiono solo gli operatori che hanno già fatto accesso a ComunicaPA almeno una volta.

## Regole e riferimenti

### Quale canale scegliere

Se l'invio deve avere valore legale, il canale è **SEND**. È l'unico con ricevute opponibili a norma di legge e raggiunge da solo anche chi non ha un domicilio digitale, spedendo su carta se serve. Sugli altri canali sappiamo se una comunicazione è stata consegnata o letta, ma non ha lo stesso valore.

| Canale | Uso |
| --- | --- |
| Email | Comunicazioni senza valore legale. |
| PEC | Comunicazioni verso un indirizzo PEC noto. Resta necessaria la protocollazione ordinaria dell'Ente. |
| App IO | Notifica sull'app IO, da sola o abbinata a un altro canale. |
| SEND | Piattaforma nazionale Notifiche Digitali: pieno valore legale. Richiede la protocollazione, integrata nell'invio. |
| Posta | Raccomandata o lettera, pensata per invii massivi. Riservata ad amministratori e operatori abilitati. |

### Regole per canale

Se il wizard blocca **Avanti** o rifiuta un campo, quasi sempre è per una di queste regole.

| Canale | Allegato | Oggetto e testo | App IO abbinata | Protocollo |
| --- | --- | --- | --- | --- |
| Email | Facoltativo | Entrambi obbligatori | Nessuna, parallela o esclusiva | Facoltativo |
| PEC | Facoltativo | Entrambi obbligatori | Nessuna, parallela o esclusiva | Facoltativo |
| App IO | Facoltativo | Oggetto 10–120 caratteri, testo 80–10.000 | — | Facoltativo |
| SEND | Obbligatorio | Solo oggetto, al massimo 134 caratteri | — | Obbligatorio |
| Posta | Obbligatorio | Solo oggetto: il contenuto è l'allegato | Nessuna, parallela o esclusiva | Facoltativo |

App IO «esclusiva» significa solo App IO, senza il canale principale. Se quel destinatario viene dirottato su PEC per il domicilio digitale, per lui l'App IO diventa automaticamente «parallela».

### Dirottamento automatico su domicilio digitale

Nelle campagne **massive** su Email, App IO o Posta il sistema controlla su INAD se ogni destinatario ha un domicilio digitale. Se lo trova, quel destinatario riceve una PEC invece del canale della campagna: a chi ha un domicilio digitale non viene spedita nessuna lettera.

Il controllo non si applica a SEND, che risolve da sé il domicilio, né all'Invio Manuale. Per sapere cosa ha ricevuto davvero un cittadino guarda il canale effettivo nel dettaglio della campagna.

### Date di notifica e termini

Ogni notifica ha **due date**, una per ciascuna parte (scissione degli effetti):

- **Notificata per l'ente**: conta per il Comune. Da quel giorno l'ente non incorre in decadenze e la prescrizione è interrotta. Per SEND è la messa a disposizione sulla piattaforma ([art. 26 D.L. 76/2020](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legge:2020-07-16;76~art26), comma 9, lett. a, e comma 10); per una raccomandata è la consegna del plico per la spedizione ([art. 149 c.p.c.](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:regio.decreto:1940-10-28;1443~art149), ultimo comma).
- **Notificata per il destinatario**: conta per il cittadino o l'impresa. **Da questa data decorrono i suoi termini**: pagamento, ricorso, adempimento. Per SEND è la data del comma 9, lett. b (tabella sotto); per una raccomandata è la consegna, il ritiro o la compiuta giacenza.

Per contare un termine del destinatario usa sempre la **data per il destinatario**, mai quella per l'ente: tra le due possono passare una o due settimane. Un atto non può diventare definitivo, né passare alla riscossione coattiva o all'esecuzione d'ufficio, prima che i termini del destinatario siano scaduti.

**Quando una notifica SEND si perfeziona per il destinatario** ([art. 26 D.L. 76/2020](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legge:2020-07-16;76~art26), comma 9, lett. b)

| Come arriva | Notificata per il destinatario |
| --- | --- |
| Aperta su SEND, anche dall'app IO | il giorno dell'apertura, se viene prima delle date sotto |
| PEC o domicilio digitale | il 7° giorno dopo la consegna nella casella (se consegnata dopo le 21, dal giorno successivo) |
| PEC piena, non valida o non attiva | il 15° giorno dopo il deposito dell'avviso di mancato recapito |
| Avviso cartaceo (raccomandata) | il 10° giorno dopo il perfezionamento della notifica cartacea: consegna, ritiro o compiuta giacenza |
| Destinatario irreperibile | deposito dell'avviso su SEND, +10 giorni per il perfezionamento dell'avviso ([comma 7](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legge:2020-07-16;76~art26)), +10 giorni per il destinatario (comma 9, lett. b, n. 2); prima se accede a SEND |

Nel dettaglio di una notifica SEND una timeline mostra le tappe fino alla data di notifica per il destinatario: le date passate, quelle previste o stimate e la data di oggi. Vale sempre la data indicata da SEND quando arriva.

La data esatta la calcola SEND ed è quella riportata nel dettaglio della notifica.

**Raccomandata non ritirata (compiuta giacenza).** Se il destinatario è assente il plico va in giacenza e gli viene spedito un avviso di deposito: la notifica si ha per eseguita 10 giorni dopo la spedizione dell'avviso, o prima se ritira il plico ([art. 8 L. 890/1982](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:1982-11-20;890~art8)).

**Esempio 1: avviso di accertamento TARI su SEND**, accettato da SEND il 01/10, PEC consegnata il 02/10:

- notificata per l'ente il **01/10**: il Comune ha notificato in tempo, anche se era l'ultimo giorno utile;
- notificata per il destinatario il **09/10** (7° giorno dopo la PEC): i 60 giorni per pagare o fare ricorso scadono l'**08/12**. Solo dopo l'atto diventa definitivo e si può passare alla riscossione coattiva.

**Esempio 2: ordinanza di demolizione firmata e inviata il 01/10.** Il destinatario ha 90 giorni per demolire ([art. 31 D.P.R. 380/2001](https://www.normattiva.it/uri-res/N2Ls?urn:nir:presidente.repubblica:decreto:2001-06-06;380~art31), comma 3) e 60 giorni per il ricorso al TAR ([art. 29 c.p.a.](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legislativo:2010-07-02;104:2~art29)), entrambi dalla notifica per lui:

| Come viene notificata | Per l'ente | Per il destinatario | Ricorso TAR entro | Demolizione entro |
| --- | --- | --- | --- | --- |
| SEND, aperta dall'app IO il 08/10 | 01/10 | 08/10 | 07/12 | 06/01 |
| SEND, PEC consegnata il 02/10 | 01/10 | 09/10 | 08/12 | 07/01 |
| SEND cartacea, consegnata il 06/10 | 01/10 | 16/10 | 15/12 | 14/01 |
| Raccomandata A/R consegnata il 06/10 | 01/10 | 06/10 | 05/12 | 04/01 |
| Raccomandata A/R non ritirata, avviso di deposito spedito il 06/10 | 01/10 | 16/10 | 15/12 | 14/01 |

Per l'ordinanza conta la data per il destinatario: se i 90 giorni si contano dalla data per l'ente, il Comune rischia di acquisire il bene prima del tempo e l'acquisizione diventa impugnabile. Se l'atto ha più destinatari (proprietario, responsabile dell'abuso) ognuno ha la sua data, nell'elenco destinatari della campagna.

I termini per i ricorsi in giudizio, compreso il TAR, restano sospesi dal 1° al 31 agosto ([art. 1 L. 742/1969](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:1969-10-07;742~art1)): un ricorso che scadrebbe in quel periodo slitta di conseguenza. I 90 giorni per demolire non sono un termine processuale e non si sospendono.

Le date si trovano nel dettaglio della notifica, nell'elenco destinatari della campagna (colonne **Notificata per l'ente** e **Notificata per il destinatario**) e nei report CSV.

### Notifica non consegnata o destinatario irreperibile

Cosa fare dipende dal canale.

**SEND.** Se il destinatario è irreperibile, SEND deposita l'avviso sulla piattaforma e la notifica **si perfeziona da sola 10 giorni dopo** ([art. 26 D.L. 76/2020](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:decreto.legge:2020-07-16;76~art26), comma 7). Il dettaglio della notifica lo segnala con «nessuna consegna». La notifica è valida, ma il destinatario può chiedere di essere rimesso in termini se dimostra di non averne avuto conoscenza senza sua colpa. Per atti pesanti (ordinanze, sanzioni rilevanti, iscrizioni a ruolo):

1. verifica la residenza in **Verifica Anagrafica** (ANPR) e il domicilio digitale (INAD, Registro Imprese);
2. se trovi un indirizzo nuovo e valido, valuta con il responsabile del procedimento una nuova notifica, anche se la prima è perfezionata;
3. annota quanto fatto, ad esempio con **Presa visione** e una nota se la notifica era tra le segnalazioni.

Se SEND **rifiuta** o **annulla** la notifica, o la **restituisce al mittente**, non c'è nessuna data legale: correggi i dati (indirizzo, codice fiscale, allegati) e invia una nuova notifica.

**Raccomandata (Posta).** Una raccomandata tornata indietro non notifica niente. Il motivo è nel dettaglio della notifica:

- **sconosciuto, trasferito, indirizzo inesatto o insufficiente**: verifica l'indirizzo in **Verifica Anagrafica** (ANPR); se è sbagliato correggilo con **Correggi indirizzo e rimetti in coda**. Se ANPR conferma un indirizzo dove il destinatario non si trova, serve la notifica tramite **messo comunale**;
- **destinatario assente e raccomandata non ritirata**: non serve fare nulla, vale la **compiuta giacenza** e la notifica è perfezionata ([art. 8 L. 890/1982](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:1982-11-20;890~art8));
- **rifiutata dal destinatario**: il rifiuto vale come consegna in mani proprie, la notifica è perfezionata ([art. 138 c.p.c.](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:regio.decreto:1940-10-28;1443~art138)).

Con il messo comunale le procedure per gli irreperibili sono due:

| Situazione | Procedura | Notificata per il destinatario |
| --- | --- | --- |
| Indirizzo giusto, ma nessuno in casa né persone che possano ricevere l'atto (irreperibilità relativa) | [art. 140 c.p.c.](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:regio.decreto:1940-10-28;1443~art140): deposito in casa comunale, avviso affisso alla porta, raccomandata informativa | quando arriva la raccomandata informativa, al più tardi 10 giorni dopo la spedizione (Corte costituzionale, sentenza 3/2010) |
| Residenza, dimora e domicilio sconosciuti (irreperibilità assoluta) | [art. 143 c.p.c.](https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:regio.decreto:1940-10-28;1443~art143): deposito nella casa comunale dell'ultima residenza, dopo le ricerche anagrafiche | il 20° giorno dopo il deposito |

Esempio: ordinanza di demolizione con raccomandata tornata per «sconosciuto»; ricerche ANPR senza esito, deposito ex art. 143 il 15/10. La notifica per il destinatario è il **04/11**: ricorso al TAR entro il 03/01, demolizione entro il 02/02.

Per atti con valore legale, se possibile, preferisci **SEND**: gestisce da sola l'irreperibilità senza passaggi dal messo.

### Protocollo e sigillo elettronico

ComunicaPA **non sostituisce il protocollo generale dell'Ente**: per gli invii PEC resta valido l'iter di protocollazione ordinario.

Per i canali che la richiedono (SEND) ComunicaPA protocolla in automatico, ma senza apporre il sigillo elettronico. Non va quindi usata al posto del protocollo ufficiale per ogni comunicazione.

### Costi degli invii

Email, PEC e App IO non costano nulla per notifica. SEND e Posta sì:

- **SEND**: un costo base per notifica, circa 1 euro, indipendente da contenuto e numero di pagine. Il costo compare nel dettaglio entro 7 giorni.
- **Posta**: il costo reale del fornitore (tipo, peso, ricevuta di ritorno), che arriva circa 24–48 ore dopo la spedizione.

Un destinatario dirottato su PEC non costa nulla in più. Il dettaglio della campagna mostra anche il risparmio stimato rispetto alla posta.

### Chi vede allegati e bozze

- **Bozze:** una campagna in bozza la vedono solo chi l'ha creata, gli amministratori e il firmatario indicato. Gli altri operatori non la trovano in **Lista Campagne**, nella ricerca notifiche, nelle statistiche dei costi né tra i job dei motori di invio. Lo stesso vale per gli invii di prova.
- **Allegati:** anteprima, download, ZIP da firmare e firma degli allegati sono riservati a chi ha creato la campagna, agli amministratori e al firmatario indicato, anche dopo l'avvio. Per gli altri i tasti sono disattivati e, nel dettaglio di una notifica, i link agli allegati nel testo del messaggio non si aprono.
- **Campagne avviate:** stato, destinatari ed esiti restano visibili a tutti gli operatori.
- **Arricchimento Tracciati:** lo ZIP con i PDF e la creazione della bozza sono riservati a chi ha caricato il tracciato e agli amministratori.

Ogni tentativo di aprire un allegato riservato resta registrato nel registro attività.

### Impostazioni (solo amministratori)

Da **Impostazioni** gli amministratori configurano server Email e PEC, App IO, SEND, Postalizzazione (fornitore e utenti abilitati), verifica INAD e aspetto del portale. Le modifiche valgono subito, senza riavvii.

## Problemi frequenti

### Il wizard non va avanti dopo la mappatura

**Causa:** manca una colonna obbligatoria per il canale scelto. I messaggi più comuni sono «La colonna Codice Fiscale / P.IVA deve essere mappata», «La colonna Email deve essere mappata per il canale EMAIL» e «La colonna PEC deve essere mappata per il canale PEC».

**Soluzione:**

1. Torna a **Mappatura & Validazione**.
2. Collega la colonna indicata nel messaggio.
3. Correggi nel file le righe segnalate come non valide (formato del CF, indirizzo email) e ricaricalo, oppure prosegui solo con le righe valide.

**Apri un ticket se:** il file è corretto e la colonna è collegata, ma l'errore resta.

### Il wizard rifiuta oggetto, testo o allegati

**Causa:** il canale ha regole proprie (vedi «Regole per canale»). Le più frequenti:

- su App IO, oggetto sotto i 10 caratteri o testo sotto gli 80;
- su SEND, oggetto oltre i 134 caratteri, anche in una sola riga della colonna CSV dell'oggetto;
- su SEND e Posta, allegato mancante;
- testo senza `%%elenco_allegati%%` (o senza tutti gli `%%allegatoN%%`) quando la campagna ha allegati.

**Soluzione:** correggi il campo indicato, seguendo la tabella «Regole per canale».

Un oggetto SEND che supera i 134 caratteri solo dopo la sostituzione dei segnaposto fa fallire l'invio con «Oggetto SEND troppo lungo»: accorcia l'oggetto e rimetti in coda la notifica.

**Apri un ticket se:** il contenuto rispetta le regole ma il wizard lo rifiuta.

### Non vedo il canale Posta nel wizard

**Causa:** il canale Posta è riservato agli amministratori e agli operatori abilitati, perché ogni spedizione ha un costo reale.

**Soluzione:** chiedi a un amministratore di abilitarti da **Impostazioni → Postalizzazione**, sezione «Utenti abilitati all'invio Postalizzazione».

**Apri un ticket se:** risulti abilitato ma il canale non compare. Esci e rientra prima di aprirlo.

### La ricerca per Partita IVA non trova l'impresa

**Causa:** per le imprese la ricerca usa il Codice Fiscale, che a volte è diverso dalla Partita IVA (enti pubblici, cooperative sociali).

**Soluzione:**

1. Riprova con il Codice Fiscale dell'impresa.
2. Se non lo conosci, usa **Non hai il codice fiscale?** e cerca per denominazione.
3. Se è un'impresa individuale e trovi una persona, spunta **Forza ricerca come impresa**.

**Apri un ticket se:** l'impresa esiste nel Registro Imprese ma non compare in nessuno dei tre modi.

### La ricerca ANPR per anagrafica viene rifiutata

**Causa:** ANPR non ammette ricerche parziali. Il messaggio è «Cognome, nome, sesso, data di nascita, comune di nascita e motivo della ricerca sono tutti obbligatori — ANPR non ammette ricerche parziali per anagrafica.»

**Soluzione:** compila tutti i campi, compreso il motivo della ricerca.

**Apri un ticket se:** tutti i campi sono compilati e la ricerca fallisce comunque.

### La campagna resta in «Verifica INAD»

**Causa:** prima dell'invio il sistema controlla il domicilio digitale di ogni destinatario su INAD e Registro Imprese. Con molti destinatari, o con i servizi nazionali lenti, il controllo può durare a lungo.

**Soluzione:**

1. Nel dettaglio della campagna premi **Aggiorna stato live** e guarda quanti blocchi sono completati.
2. Se il controllo è fermo, premi **Riprova verifica**.
3. Se serve inviare subito, premi **Salta verifica e procedi** e conferma: si procede con i canali configurati nella campagna, senza dirottamento su PEC.
4. Per fermare tutto premi **Annulla campagna**.

**Apri un ticket se:** dopo **Riprova verifica** il conteggio non avanza per più di 30 minuti.

### All'avvio compare «Verifica dei domicili digitali non avviata»

**Causa:** al momento del lancio INAD o il Registro Imprese non rispondevano. La campagna non parte e torna in bozza, senza nessun invio.

**Soluzione:** attendi qualche minuto e premi di nuovo **Lancia Campagna**. I dati della campagna restano quelli già inseriti.

**Apri un ticket se:** il messaggio si ripete per più di un'ora.

### Alcuni destinatari sono «PEC da verificare»

**Causa:** in una campagna PEC verso imprese la PEC del file è diversa da quella del Registro Imprese. Il sistema non sceglie da solo e blocca l'invio per quei destinatari. Due PEC che differiscono solo per maiuscole e minuscole (es. `NOME@PEC.IT` e `nome@pec.it`) sono considerate uguali e non vengono bloccate.

**Soluzione:** nel dettaglio della campagna, riquadro «PEC difformi da verificare», confronta per ciascun destinatario la PEC su file con quella trovata e premi **Mantieni PEC su file** oppure **Usa PEC trovata**. Dopo la scelta l'invio a quel destinatario parte.

**Apri un ticket se:** dopo la scelta il destinatario resta bloccato.

### Alcuni destinatari risultano «Fallito»

**Causa:** l'invio a quei destinatari non è riuscito. Il dettaglio della campagna li raggruppa per motivo, nella tabella «Destinatari con invio fallito».

**Soluzione:**

1. Leggi il motivo dell'errore.
2. Se il problema era temporaneo (server non raggiungibile, limite di invio), premi **Rimetti in coda tutti** su quel gruppo.
3. Se il problema è un indirizzo postale, correggilo con **Correggi indirizzo e rimetti in coda**.
4. Se è un indirizzo email o PEC errato: sul destinatario non si può correggere. Verifica il recapito giusto con **Verifica Anagrafica** e invialo con un **Invio Manuale**.

I destinatari di una campagna annullata non si possono rimettere in coda.

**Apri un ticket se:** dopo la nuova messa in coda tutto il gruppo fallisce di nuovo con lo stesso motivo.

### Un indirizzo postale viene rifiutato

**Causa:** il fornitore della posta accetta solo indirizzi completi e nei limiti di lunghezza. I messaggi sono «Indirizzo e Comune sono obbligatori», «La provincia è obbligatoria per gli indirizzi italiani» e «La città non può superare i 30 caratteri».

**Soluzione:** completa l'indirizzo con indirizzo, comune e provincia; abbrevia il nome della città se supera 30 caratteri. Poi premi **Correggi indirizzo e rimetti in coda**.

**Apri un ticket se:** l'indirizzo è completo e corretto ma viene rifiutato.

### Il costo di posta o SEND risulta zero

**Causa:** il costo reale arriva dopo la spedizione: circa 24–48 ore per la posta, fino a 7 giorni per SEND. Fino ad allora il widget **Costo Campagna** mostra 0 €.

**Soluzione:** nessuna, non è un errore. Ricontrolla il dettaglio della campagna nei giorni successivi.

**Apri un ticket se:** il costo è ancora 0 € dopo 48 ore per la posta o dopo 7 giorni per SEND.

### SEND: «allegato/i non firmati validamente» al Passo 6

**Causa:** per le campagne SEND massive ComunicaPA verifica la firma digitale di ogni allegato. Il messaggio compare quando uno o più PDF non hanno una firma digitale valida (per esempio documenti con firma autografa a stampa).

**Soluzione:** firma gli allegati dal riquadro (vedi [Firmare gli allegati SEND](#firmare-gli-allegati-send)). Se devi inviare comunque, premi **Conferma ed Avvia Campagna** e conferma l'avviso: l'invio parte sotto la tua responsabilità e la forzatura resta registrata nel registro attività. Senza firma valida la notifica può essere contestata.

**Apri un ticket se:** il messaggio «Verifica firma digitale allegati in corso…» resta visibile per più di qualche minuto.

### Una notifica SEND irreperibile non compare tra le segnalazioni

**Causa:** per SEND il destinatario irreperibile non blocca la notifica: la piattaforma la perfeziona comunque e assegna la data di perfezionamento per il destinatario. Non è quindi una notifica senza esito.

**Soluzione:** nessuna sul sistema. Le date legali si leggono nel dettaglio della notifica. Per atti importanti valuta se rintracciare il destinatario e notificare di nuovo: vedi [Notifica non consegnata o destinatario irreperibile](#notifica-non-consegnata-o-destinatario-irreperibile).

**Apri un ticket se:** la notifica risulta irreperibile e dopo 45 giorni non è ancora perfezionata per il destinatario.

### Firma con Aruba: «Sessione scaduta dopo X file»

**Causa:** la sessione di firma Aruba ha una durata limitata; con molti file può scadere prima della fine.

**Soluzione:** premi di nuovo **Firma con Aruba** e inserisci un nuovo OTP: vengono firmati solo i file rimasti.

**Apri un ticket se:** la sessione scade sempre entro i primi file.

### Firma con Aruba: «Credenziali o OTP non validi» o «Dominio non abilitato»

**Causa:** utente, password o OTP errati (l'OTP scade in pochi secondi), oppure il dominio in Impostazioni non corrisponde alla tua firma.

**Soluzione:** genera l'OTP subito prima di premere **Firma**. Per il dominio chiedi all'amministratore di verificare **Impostazioni → Firma remota** con **Prova firma**.

**Apri un ticket se:** la **Prova firma** fallisce con credenziali corrette.

### Non riesco a modificare o eliminare una campagna

**Causa:** dipende dal messaggio.

- «Non puoi modificare una campagna creata da un altro operatore»: solo chi l'ha creata (o un amministratore) può avviarla, inviare il test, annullarla o eliminarla. La firma degli allegati è aperta anche al firmatario indicato (vedi [Indicare il firmatario di una campagna SEND](#indicare-il-firmatario-di-una-campagna-send)).
- «Solo le campagne in bozza possono essere modificate»: la campagna è già partita.
- «Campagna a valore legale: eliminazione non consentita per campagne avviate»: una campagna con valore legale già avviata resta per sempre nello storico.

**Soluzione:** per una campagna di un collega chiedi a lui. Per una campagna già partita crea una nuova campagna. Per fermare una campagna in corso o in verifica INAD usa **Annulla campagna**.

**Apri un ticket se:** devi intervenire su una campagna di un collega assente.

### Non riesco ad aprire un allegato o non vedo una bozza

**Causa:** allegati e bozze sono riservati a chi ha creato la campagna, agli amministratori e al firmatario indicato (vedi [Chi vede allegati e bozze](#chi-vede-allegati-e-bozze)). Il tasto è disattivato e mostra «Allegato visibile solo a chi ha creato la campagna, agli amministratori e al firmatario indicato»; una bozza aperta da un link dà «Campagna non trovata o non accessibile».

**Soluzione:** se devi firmare gli allegati, chiedi a chi ha creato la campagna di indicarti come firmatario. Per gli allegati di una campagna già avviata rivolgiti a chi l'ha creata o a un amministratore.

**Apri un ticket se:** sei il creatore, un amministratore o il firmatario indicato e l'allegato resta comunque bloccato.

### Il firmatario non compare nell'elenco

**Causa:** l'elenco dei firmatari contiene solo gli operatori che hanno già fatto accesso a ComunicaPA.

**Soluzione:** chiedi al collega di accedere una volta a ComunicaPA con le sue credenziali, poi riapri il Passo 6 e sceglilo.

**Apri un ticket se:** il collega ha già fatto accesso e non compare ancora.

### Il dirigente non riesce più a firmare una bozza SEND già pronta

**Causa:** le bozze SEND create prima di questa modifica non hanno un firmatario indicato, quindi il dirigente non le vede più.

**Soluzione:** chi ha creato la campagna (o un amministratore) apre la bozza al Passo 6 e indica il dirigente come **Firmatario**. Vedi [Indicare il firmatario di una campagna SEND](#indicare-il-firmatario-di-una-campagna-send).

**Apri un ticket se:** chi ha creato la bozza non è più in servizio e non c'è un amministratore disponibile.

### App IO: «Nessun servizio App IO configurato»

**Causa:** manca un servizio App IO predefinito nelle impostazioni. Il messaggio è «Nessun servizio App IO configurato o abilitato come predefinito».

**Soluzione:** chiedi a un amministratore di configurarlo in **Impostazioni**.

**Apri un ticket se:** non c'è un amministratore disponibile o il servizio risulta già configurato.

### Non riesco ad accedere

**Causa:** il messaggio «Credenziali non valide o servizio LDAP non disponibile.» compare con utente o password sbagliati, con password scaduta o se il server di dominio non risponde.

**Soluzione:**

1. Controlla di usare utente e password del PC (non quelli di SPID o della posta, se diversi).
2. Se la password del PC è scaduta, cambiala e riprova.
3. Se anche i colleghi non riescono ad accedere, il problema è del server, non tuo.

**Apri un ticket se:** le credenziali funzionano sul PC ma non qui, oppure nessuno riesce ad accedere.

## Contatti

Per problemi non risolti con questa guida apri un ticket dalla plancia dei dipendenti (CruscottoPA), scegliendo ComunicaPA. Indica il nome della campagna o il codice fiscale interessato e il messaggio di errore esatto.
