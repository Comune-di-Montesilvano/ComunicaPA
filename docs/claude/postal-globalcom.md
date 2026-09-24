# POSTAL — GlobalCom SOAP

## POSTAL — GlobalCom SOAP, gotcha critico

Web service ASMX legacy (`node-soap`), non un'API REST moderna — alcune
convenzioni non sono deducibili dal solo WSDL/manuale, verificate solo
con credenziali reali (**un riassunto del solo WSDL ha già portato a
conclusioni sbagliate una volta in questa integrazione**, verificare
sempre scaricando l'XSD raw o testando dal vivo).

**Campo esito risposta = `<nomeMetodo>Result`, non `Result` generico.**
Convenzione ASMX standard (`LoginResult`, `invio_ext_singoloResult`,
`dettagli_documentoResult`...) — leggere `result.Result` è sempre
`undefined`/falsy, marca FAILED anche un invio realmente ACCETTATO da
GlobalCom (bug reale: un invio con `Stato=Accettato` e IDPRO assegnato
registrato come fallito lato nostro — rischio concreto di doppio invio
su un retry successivo).

**Array (`Destinatari`/`Files`, anche in risposta `ProdottiDisponibili`/
`ContrattiH2H`) sono tipi WSDL `ArrayOfX`**: l'elemento ripetuto dentro
il contenitore si chiama come il TIPO dell'item (`InfoIndirizzoExt`,
`InfoFileExt`, `ServiceType`, `DatiContrattoCOLMOLExt`), non come il
campo. Un array JS nudo produce un contenitore vuoto/non riconosciuto —
il server risponde "Il documento inserito deve contenere almeno un
destinatario" anche con un destinatario effettivamente passato.

**Nomi parametro nel manuale ≠ nomi WSDL reali.** Il manuale usa
"gruppo" solo nel testo descrittivo italiano e nell'esempio C# (dove il
nome del parametro posizionale è irrilevante) — il WSDL live usa
`group` (inglese). Verificare sempre l'XSD scaricato, mai fidarsi del
nome usato in prosa/esempio.

**Messaggi d'errore Login ambigui**: GlobalCom risponde con lo stesso
identico testo ("La combinazione di utente e gruppo non è valida") sia
per username/gruppo sbagliati sia per password errata — non
distingue le due cause lato loro.

**Mai loggare l'XML di richiesta del Login** (nemmeno a `LOG_LEVEL=debug`):
contiene la password in chiaro nel body SOAP. Loggare solo la risposta.

**Configurazione**: multi-provider in tabella dedicata
`postal_provider_configs` (`PostalProvidersService`), stesso pattern di
`mail_server_configs` per EMAIL/PEC — non chiavi flat in `app_settings`.
Tipologie di invio abilitate (`ProdottiDisponibili`) e codici contratto
(`ContrattiH2H`) sono scoperti automaticamente dal tasto "Test"
(`InformazioniUtenza`, sola lettura), mai configurati a mano — un'utenza
può essere abilitata solo su varianti "Market"/"Contest" (canale
Postel/Irideos), mai su Lettera/Raccomandata standard (canale Poste
diretto), e i Servizio "Market"/"Contest"/Atto Giudiziario richiedono un
`CodiceContratto` valido specifico per utenza.

**Il DB dev ha il provider GlobalCom REALE di produzione** (Montesilvano,
nessun sandbox separato) — un IDPRO/dato reale fornito dall'utente e
assente dal DB dev si può comunque testare dal vivo contro il vero
webservice, decriptando `password_enc` con
`deriveSettingsKey(process.env.JWT_SECRET)` + `decryptValue()`
(`settings-crypto.ts`). Mai loggare la password decriptata.

**`RicevutaDiRitorno=true` richiede anche `Colore`/`FronteRetro` e un
`Ricevuta` esplicito.** `Colore`/`FronteRetro` (stampa a colori/fronte-retro)
sono booleani obbligatori nel WSDL (`InfoGUIDExt`, verificato sull'XSD
live) — vanno sempre inviati, non solo quando true. Con AR attiva serve
anche il campo `Ricevuta` (`InfoIndirizzoExt`, indirizzo a cui torna la
cartolina firmata): omesso, GlobalCom risponde "Destinatario ricevuta: I
campi Denominazione1 e Denominazione2 sono entrambi vuoti".
`UsaDestinatarioARPredefinito=true` (stesso pattern di
`UsaMittentePredefinito`) è un fallback che presuppone un indirizzo AR
predefinito configurato lato GlobalCom sull'utenza — non è il caso
generale (errore reale: "E' stato richiesto il destinatario AR
predefinito per questo utente, ma non è presente in archivio"). Soluzione
adottata: `Ricevuta` = mittente configurato (`postal.strategy.ts`,
`ricevuta: ricevutaDiRitorno ? provider.mittente : undefined`) — la
cartolina AR torna al mittente, comportamento standard per raccomandate PA.

**Campo `Nazionale` (InfoGUIDExt) obbligatorio, nessun default.** Mai
valorizzato prima di un fix reale: GlobalCom applicava il default
nazionale e rigettava ogni invio con `Stato` estero valorizzato ("è
stato indicato un invio nazionale, ma lo stato del destinatario non
risulta l'Italia"), anche con contratto `Estero:true`. Fix:
`Nazionale: !destinatario.stato` in ogni `invio_ext_singolo`
(`globalcom-client.service.ts`). **CAP non forwardato per indirizzo
estero**, stesso principio già in vigore per Provincia: GlobalCom
valida `InfoIndirizzoExt.CAP` come "se presente, 5 cifre" (formato
italiano) — un CAP estero (es. belga "1180") viene rigettato
("Il CAP, se presente, deve essere un numero di cinque cifre").

**Errore GlobalCom `-1: "numeri raccomandata non salvati o non
disponibili"` (visibile solo su `postal_status_history`/portale GlobalCom,
mai in `invio_ext_singolo` — arriva DOPO l'accettazione, `Stato` passa da
`Accettato` a `Errore` al poll successivo) è confermato lato GlobalCom
essere un problema dei server Poste Italiane (mancata assegnazione del
numero identificativo raccomandata a monte), non un bug del nostro payload
SOAP — verificato XML request/response reale, tutti i campi (`Ricevuta`,
`Colore`, `FronteRetro`, `CodiceFiscale`) corretti. Nessuna azione
lato nostro possibile: intermittente, segnalare a supporto GlobalCom con
l'IDPRO se persiste.**

**`CodiceErrore`/`descrizione` NON sono legati allo `Stato` — mai gatare su
`stato==='Errore'`.** GlobalCom manda un `CodiceErrore` reale (es. `-2`,
"Richiesta HTTP vietata con lo schema di autenticazione client 'Basic'")
anche su stati transitori come `Rimandato` (durante un retry lato loro) —
gatare la persistenza su `stato==='Errore'` nasconde quell'informazione
finché non arriva un vero stato terminale (bug reale corretto). Ma manda
anche un `CodiceErrore` "benigno" (`"0"`) su stati positivi come
`Confermato` — persisterlo comunque mostra in UI un invio riuscito come se
fosse un errore (altro bug reale corretto: "GlobalCom (0)" su una
raccomandata in realtà confermata). Il criterio giusto è il **valore** di
`CodiceErrore` (`!== '0'`), non lo `stato` associato — vedi
`postal-status-sync.service.ts`/`App.tsx` (colonna Errore, dettaglio
notifica).

**Atto Giudiziario richiede sempre `Ricevuta`/AR, indipendente dal
checkbox "Ricevuta di ritorno" (per Agol resta nascosto/forzato sempre
attivo).** `ricevutaDiRitorno` era gated solo su
`servizio.startsWith('Raccomandata')` — per Agol restava sempre `false`,
GlobalCom accettava l'invio ma falliva dopo, in lavorazione (`Stato:
Accettato → Errore`, `CodiceErrore -2` "Nessun destinatario ricevuta
trovato per questa spedizione"): l'AR è obbligatoria per legge sull'Atto
Giudiziario, non opzionale come per una raccomandata. Riprodotto e
confermato dal vivo su due campagne reali. Stesso Servizio richiede anche
sempre protocollazione preventiva (`channelConfig.protocolla`), stesso
obbligo già in vigore per SEND — vedi
`assertSendProtocolConfigured`/`isChannelAlwaysLegalValue`.

**Atto Giudiziario (`AgolMarket`/`AgolBusiness`, non `AttoGiudiziario*` —
nome facilmente sbagliato, verificare sempre l'enum `ServiceType` reale
sul WSDL, non un riassunto) richiede `OpzioniAgol` (`DatiAgol`) sempre
popolato, mai omesso**: `TipoNotificante`, `SecondoTentativoRecapito`,
`AvvisoRicevimentoDigitale` sono dereferenziati incondizionatamente dal
codice GlobalCom per questo Servizio — omessi, `NullReferenceException`
generico ("Riferimento a un oggetto non impostato su un'istanza di
oggetto"), zero informazione diagnostica. `AvvisoRicevimentoDigitale`
in particolare ha comportamento ancora poco chiaro, verificato solo in
parte: con CF reale e flag `false` → errore esplicito "Ritiro digitale
richiesto... Avviso di Ricevimento digitale è obbligatorio"; con flag
`true` e destinatario senza email in anagrafica → torna comunque
NullReferenceException generico (ipotesi non confermata: manca un
contatto digitale — `Email` su `InfoIndirizzoExt`, aggiunta ma non ancora
testata con un valore reale — a cui recapitare l'avviso). Osservato anche
che un CF con checksum non valido ("inventato", non solo un CF reale mai
esistito) sembra produrre lo stesso NullReferenceException indipendentemente
dal flag `AvvisoRicevimentoDigitale` — ipotesi: GlobalCom valida/processa il
CF solo per Servizio Agol, un checksum invalido manda in crash quel path
invece di restituire un errore applicativo.

**Confermato con test reale (invio accettato, Stato=Accettato):** la causa
di entrambi gli errori era il `CodiceFiscale` sul destinatario — GlobalCom
lo usa (solo per Servizio Agol) per verificare un domicilio digitale e
richiedere/proporre il ritiro digitale, che questo Comune non vuole mai
usare via GlobalCom per Atto Giudiziario (nessun caso d'uso reale).
`postal.strategy.ts` ora omette `codiceFiscale` sul destinatario quando
`servizio.startsWith('Agol')`, mantenendolo per gli altri Servizio
(Raccomandata/Lettera, dove non risulta causare problemi). `Email` su
`InfoIndirizzoExt` resta comunque valorizzata quando disponibile (innocua,
non richiesta senza CF).

**WebFetch sul WSDL GlobalCom non è affidabile su nomi enum/campi al primo
giro** — una query ha restituito `AttoGiudiziarioBusiness`/`AttoGiudiziarioMarket`
(mai esistiti), il valore reale è `AgolBusiness`/`AgolMarket` (enum
`ServiceType`). Prima di scrivere codice che dipende da un nome di
campo/enum, rifare una seconda WebFetch mirata proprio su quell'enum/tipo
per confermare, non fidarsi del primo riassunto (stesso principio già in
nota per il manuale POSTAL/SEND sopra).

**Nessuna operazione di annullamento/cancellazione invio nel WSDL
GlobalCom** — inventario completo delle 61 operazioni verificato
(`invio_ext_singolo`, `AutorizzaLottoInvio`, `account_*`, ecc.): l'unica
azione "annulla invio in preparazione" vista sul portale GlobalCom è solo
UI loro, non esposta via API — non automatizzabile da questo codebase.

**Un nuovo metodo SOAP ASMX: `<nomeMetodo>Result` è SEMPRE il booleano di
esito, MAI il wrapper dati.** Bug reale (`listaRiaccodamentiDocumento`):
leggeva `result.lista_riaccodamenti_documentoResult.string` assumendo che
il wrapper `ArrayOfString` vivesse lì — invece quel campo è `true`/`false`
(stessa convenzione di `dettagli_documentoResult`/`invio_ext_singoloResult`),
i dati sono sempre in `Risposta`. `.string` su un booleano è `undefined`
senza errore — ricadeva silenziosamente sul solo IDPRO originale anche con
un riaccodamento reale presente, zero log/eccezioni. Verificato dal vivo
contro GlobalCom prod (Montesilvano) con IDPRO reale. Per ogni nuovo
metodo SOAP: dati sempre da `Risposta`, mai dal campo `<metodo>Result`.

**Script di debug per interrogare GlobalCom a mano su un IDPRO reale**:
`apps/backend/src/debug/globalcom-dettagli-documento.cjs` — replica a mano
login+cookie di sessione+`dettagli_documento` senza passare da nest
build/dist (decripta la password del provider POSTAL attivo dal DB dev,
stesso pattern già noto per testare IDPRO reali assenti dal DB dev). Uso:
`docker compose exec backend node src/debug/globalcom-dettagli-documento.cjs <IDPRO>`.
Estensione `.cjs`, non `.js`: `apps/backend/package.json` ha `"type": "module"`,
quindi un `.js` in questo package verrebbe trattato come ESM e il `require()`
in cima allo script fallirebbe con `ReferenceError: require is not defined`.
Due gotcha già presi a mazzate una volta, incorporati nello script: (1)
`LoginAsync` vuole `user`/`password`/`group` minuscoli inglesi — nomi
diversi producono un `NullReferenceException` generico, non un errore di
auth leggibile; (2) la sessione dopo Login è un **cookie HTTP**
(`set-cookie` nella risposta), non un token nel payload — senza
riapplicarlo con `client.addHttpHeader('Cookie', ...)` ogni chiamata
successiva torna `CodiceErrore "0401" "NOK: Login"` anche con credenziali
corrette. `apps/backend/src/debug/` è escluso da `.dockerignore`
(`apps/backend/src/debug`) — mai finire nell'immagine, anche se `tsc`
(nessun `allowJs`) non lo compilerebbe comunque. Qualunque futuro script
di debug backend va in questa cartella, stesso trattamento.

**Debug live in produzione via console Portainer (niente accesso docker CLI
da host, solo console-exec sul container) — niente heredoc, one-liner con
quote non annidate.** `node <<'EOF' ... EOF` spesso non funziona in quella
console (non è un vero terminale interattivo, l'input multi-riga si perde
silenziosamente — sintomo "non vedo nulla", nessun errore). Usare un
one-liner `node -e '...'` con apici ESTERNI singoli e stringhe JS SOLO in
doppi apici (mai annidare lo stesso tipo di apice — rotto 2 volte dal vivo
prima di arrivare alla forma corretta, es. un backtick SQL con `'queued'`
dentro chiudeva prematuramente l'apice esterno). Verificare il comando
scrivendolo su file e rileggendolo prima di darlo all'operatore, mai
fidarsi dell'escaping a mente. `pg`/`bullmq`/`ioredis` sono dipendenze
dirette di `apps/backend/package.json` — `require()` diretto funziona
anche nel container prod (niente bisogno del percorso
`.pnpm/node_modules/` che serve invece per una dipendenza transitiva come
`jsonwebtoken`, vedi sopra "Token operatore admin").

**Anche un one-liner SENZA apici problematici può spezzarsi se troppo
lungo** (il client inserisce newline reali ai punti di wrap visivo, non
solo un problema di quoting SQL). Se un comando da ~700+ caratteri fallisce
con errori di sintassi strani su una riga che non c'entra, non è il
codice: accorciare drasticamente (nomi variabili minimi, dividere in più
comandi sequenziali) prima di sospettare altro.

**SQL con apostrofi in un one-liner Portainer**: usa quoting a dollaro Postgres
(`$$valore$$`) al posto degli apici singoli — l'apice esterno del one-liner
`node -e '...'` non ammette nessun apice singolo annidato, `$$...$$` lo aggira
senza escaping. Pattern verificato dal vivo per diagnosticare attempt "queued"
senza job BullMQ reale: query `pg` diretta + `bullmq`/`ioredis` per confrontare
`notification_attempts.status` con `queue.getJob(id)` — stesso principio del
repair script già noto, utile anche solo per la diagnosi senza riparare nulla.

**`$$...$$` è dollar-quoting SQL (per un valore letterale dentro il TESTO
della query), non sintassi JavaScript** — va sempre dentro una stringa JS
vera (`"SELECT ... WHERE x=$$val$$"`), mai scritto bare come
`pg.query($$SELECT...$$)`: quello è un `SyntaxError: missing ) after
argument list` immediato (rifatto una volta dal vivo). Più semplice e
meno rischioso: query parametrizzate (`$1`/`$2` + array valori) invece di
interpolare `$$...$$` nel testo SQL.

**`StatoConsegna` vuoto è a volte un dato mancante lato GlobalCom stesso,
non un bug nostro.** Verificato dal vivo con lo script di debug sopra su 3
IDPRO reali (`RaccomandataMarket4`, sia esteri che italiani, spediti 5+
giorni prima): `dettagli_documento` risponde `Stato: Confermato` con
`StatoConsegna: ""` per tutti e tre, costo già dettagliato (documento
realmente stampato/spedito) — non un problema di parsing/salvataggio né di
round-robin del cron, il dato non c'è proprio lato GlobalCom. Ipotesi
iniziale "succede solo per indirizzi estero" confutata dal terzo IDPRO
(italiano, stesso esito). Prima di sospettare un bug nostro su questo
sintomo, verificare con lo script contro IDPRO reali — se `StatoConsegna`
torna vuoto anche da loro, è un problema esterno (stesso tipo già noto per
l'errore `-1`), segnalare a supporto GlobalCom con gli IDPRO, nessuna
azione lato codice possibile.



**Documento GlobalCom in errore/`Eliminato`: mai riaccodarlo a mano.**
Confermato dal supporto GlobalCom: lo riaccodano loro se serve, e il nuovo
invio arriva sotto un nuovo IDPRO (`lista_riaccodamenti_documento`) che il
sistema registra come presa d'atto, senza reinviare nulla lato nostro.

**Limiti lunghezza nominativo**: GlobalCom `Denominazione1` max 44
caratteri (nominativi tipo "COLLETTIVAMENTE AGLI EREDI DI ..." lo superano:
viene spezzato su `Denominazione2` da `denominazione.util.ts`); SEND `denomination` max 88 caratteri.

**Chi può avviare un invio POSTAL** (costo reale per spedizione): sempre gli
`admin`, più gli `user` presenti in `postal_authorized_users` (CRUD in
Impostazioni → Postalizzazione). Il controllo copre solo l'avvio
(`launch()`/`launchTestSend()`); retry, correzione indirizzo e correzione
contenuto su una campagna già avviata restano permessi a tutti. Il gate nel
wizard è solo UX, quello vero è server-side.

**Backlog mai implementato — verifica CAP/stradario**: GlobalCom espone un
secondo servizio `GBCCap.asmx` (stesso host, `gbcweb/GBCCap.asmx?wsdl`) con
`CittaDaCap`, `ListaCAPDaCitta`, `ListaVieDaCAP` e la lista `DUG`
(VIA/VIALE/...) per normalizzare le vie: base per una verifica indirizzi
pre-invio, da chiamare per tupla (via, città, CAP) deduplicata, mai per riga.
