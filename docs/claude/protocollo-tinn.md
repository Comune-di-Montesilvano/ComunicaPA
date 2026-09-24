# Protocollo Informatico — connettore TINN (SOAP)

Modulo `apps/backend/src/protocollo/` (`ProtocolloService`). Obbligatorio per
SEND (`paProtocolNumber`) e per POSTAL Atto Giudiziario/Agol, opzionale per
gli altri canali via `channelConfig.protocolla` (vedi
`assertSendProtocolConfigured`/`isChannelAlwaysLegalValue`).

**Tre chiamate SOAP RPC/encoded in sequenza**, envelope costruiti a mano con
stringhe template (niente libreria `soap`: lo stile RPC/encoded è troppo
datato per un generatore da WSDL):

1. `Login(strCodEnte, strUserName, strPassword)` → `strDST` (token di
   sessione, in cache in memoria).
2. `Inserimento(Username, DSTLogin, FileBinario)` → `lngDocID` temporaneo
   del PDF caricato.
3. `Protocollazione(Username, DSTLogin, FileXML)` → `lngNumPG`,
   `lngAnnoPG`, `strDataPG`. `FileXML` è l'XML "Segnatura" (flusso in
   **uscita**, `Flusso=U`, unico caso d'uso) che referenzia il `lngDocID`
   in `<Descrizione><Documento id="...">`, con `CodiceTitolario`/
   `CodiceAmministrazione`/`UnitaOrganizzativa` da Impostazioni.

Gotcha verificati:

- **File in base64 inline nel body**, non MIME multipart: il WSDL tipizza
  `FileBinario`/`FileXML` come `xs:base64Binary` (la doc testuale parla di
  "Attachment MIME", ma è il base64 inline a funzionare).
- **Esito = `lngErrNumber`**: `!= 0` è errore anche con HTTP 200. I tag di
  risposta hanno attributi RPC (`<strDST xsi:type="xsd:string">`), il parsing
  deve tollerarli.
- **DST scaduto** (`DST non valido`, `sessione scaduta`, codice `-2`): un
  solo re-login automatico e retry, mai un loop.
- Timeout per chiamata configurabile (`protocollo.timeoutMs`, default 120s)
  con retry su errori di rete/timeout: il servizio reale è lento sui PDF grandi.
- Un fallimento di una qualunque delle tre chiamate fa fallire l'attempt:
  mai un invio "senza protocollo" quando `protocolla=true`.

**L'endpoint configurato è produzione reale** (nessun ambiente di collaudo):
mai chiamate automatiche da test/CI, solo unit test con `fetch` mockato.
Credenziali solo da UI Impostazioni → Protocollo (password cifrata), mai in
file versionati.
