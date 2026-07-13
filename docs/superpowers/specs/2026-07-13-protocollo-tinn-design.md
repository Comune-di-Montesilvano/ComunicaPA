# Connettore Protocollo Informatico (TINN) — Design

## Contesto

Progetto più ampio richiesto dall'utente: il cittadino deve poter vedere nel
portale tutte le notifiche SEND ricevute, con stato/timeline reali da PDND.
Esplorando lo stato attuale sono emersi due blocchi a monte:

1. `SendStrategy` invia oggi verso un endpoint SEND placeholder (non il vero
   `POST /delivery/v2.6/requests`), quindi non esistono IUN reali da
   interrogare.
2. Il payload reale SEND richiede un `paProtocolNumber` (numero di protocollo
   PA) — l'utente ha chiesto di integrare il vero servizio di Protocollo
   Informatico dell'ente (prodotto TINN, web service SOAP) invece di un
   valore fittizio.

Il lavoro complessivo è stato decomposto in 3 sotto-progetti sequenziali,
ciascuno con spec/piano propri:

1. **Questo documento**: connettore Protocollo TINN.
2. Invio SEND reale (payload v2.6/requests, preload allegati S3, digest).
3. Stato/timeline SEND reale nel dettaglio cittadino + operatore.

Il tab "Protocollo" nelle Impostazioni admin esiste già in UI ma è
**completamente finto**: usa `localStorage` invece di `AppSettingsService`,
nessun backend, nessuna chiamata reale — va reso funzionante.

## Riferimento API

Specifiche fornite dall'utente in `tinn/` (WSDL, XSD, esempi XML, doc
tecnica). Servizio SOAP RPC/encoded, tre metodi, in sequenza:

1. **Login**(`strCodEnte`, `strUserName`, `strPassword`) →
   `{strDST, lngErrNumber, strErrString}` — DST è il token di sessione,
   valido "durante una sessione di lavoro", va rinfrescato se scaduto.
2. **Inserimento**(`strUserName`, `strDSTName`, file binario) →
   `{lngDocID, lngErrNumber, strErrString}` — carica il documento (il PDF
   della notifica), ottiene un id documento temporaneo.
3. **Protocollazione**(`strUserName`, `strDSTName`, file XML "Segnatura") →
   `{lngNumPG, lngAnnoPG, strDataPG, lngErrNumber, strErrString}` — crea la
   registrazione di protocollo vera e propria, referenzia il `lngDocID` di
   Inserimento nella sezione `<Descrizione><Documento id="...">`.

XML "Segnatura" per protocollazione in **uscita** (`Flusso=U`, unico caso
d'uso: ComunicaPA manda comunicazioni verso il cittadino), da
`tinn/RichiestaProtocollazioneInUscitaConSoloDocumentoPrincipale.xml`:

```xml
<Segnatura versione="2001-05-07" xml:lang="it">
  <Intestazione>
    <Oggetto>...</Oggetto>
    <Identificatore>
      <NumeroRegistrazione>0</NumeroRegistrazione>
      <DataRegistrazione>0</DataRegistrazione>
      <Flusso>U</Flusso>
    </Identificatore>
    <Mittente>
      <Amministrazione>
        <Denominazione>...</Denominazione>
        <IndirizzoTelematico tipo="smtp"></IndirizzoTelematico>
        <UnitaOrganizzativa id="1" />
      </Amministrazione>
    </Mittente>
    <Destinatario>
      <Persona id="<CF>">
        <Nome>...</Nome><Cognome>...</Cognome>
        <CodiceFiscale>...</CodiceFiscale>
        <Denominazione>...</Denominazione>
        <IndirizzoTelematico tipo="smtp"></IndirizzoTelematico>
      </Persona>
    </Destinatario>
    <Classifica>
      <CodiceAmministrazione>1</CodiceAmministrazione>
      <CodiceTitolario>6022</CodiceTitolario>
    </Classifica>
  </Intestazione>
  <Descrizione>
    <Documento id="<docId da Inserimento>" nome="<nomefile>.pdf">
      <DescrizioneDocumento>...</DescrizioneDocumento>
    </Documento>
  </Descrizione>
</Segnatura>
```

Parametri reali di produzione forniti dall'utente in chat (URL, Codice Ente,
Username, Password) — **non riportati qui né in nessun file versionato**:
vanno inseriti solo da UI admin (tab Impostazioni → Protocollo, valori
cifrati a riposo come gli altri secret) o in `.env` locale non tracciato,
mai in commit/spec/codice. Gerarchia di Classificazione (→
`CodiceTitolario`) di riferimento: `6022`.

**Rischio tecnico aperto**: il WSDL tipizza `FileBinario`/`FileXML` come
`xs:base64Binary` in un body SOAP RPC/encoded — la doc testuale parla anche
di "Attachment MIME alla richiesta" (potrebbe essere vero
multipart/SOAP-with-Attachments). L'implementazione parte da base64 inline
nel body (coerente col tipo dichiarato nel WSDL) e verrà validata contro
l'endpoint reale; se necessario si passa a MIME multipart.

## Architettura

Nuovo modulo `apps/backend/src/protocollo/`, stesso pattern di
`apps/backend/src/pdnd/`:

- **`protocollo.service.ts`** — `ProtocolloService`:
  - `login(): Promise<string>` — chiama SOAP `Login`, cache in memoria del
    DST con retry automatico (un solo re-login) se una chiamata successiva
    fallisce per sessione scaduta.
  - `protocolla(input: { oggetto: string; destinatario: { codiceFiscale, nome, cognome, denominazione }; documentBuffer: Buffer; documentFilename: string }): Promise<{ numeroProtocollo: number; annoProtocollo: number; dataProtocollazione: string }>` —
    orchestratore: login (se serve) → Inserimento (carica `documentBuffer`) →
    costruisce XML Segnatura (`Flusso=U`) → Protocollazione → ritorna
    risultato.
  - Costruzione/parsing envelope SOAP fatti a mano con stringhe template
    (niente libreria `soap` — stile RPC/encoded troppo datato per un
    generatore automatico da WSDL); l'XML "Segnatura" costruito con semplice
    string building/escape (nessuna libreria XML pesante necessaria, pattern
    coerente con `apps/backend/src/channels/send/pdnd-auth.service.ts` che
    già non usa librerie esterne per costruire richieste).
- **`protocollo.module.ts`** — esporta `ProtocolloService`.

## Settings (registry + tab admin, sostituendo il mock attuale)

Nuove chiavi in `apps/backend/src/settings/settings.registry.ts`:

```
protocollo.provider          → string, default 'tinn'  (unico valore oggi supportato)
protocollo.baseUrl           → string, default ''
protocollo.codiceEnte        → string, default ''
protocollo.username           → string, default ''
protocollo.password           → string, secret: true, default ''
protocollo.codiceTitolario    → string, default '6022'
protocollo.codiceAmministrazione → string, default '1'
protocollo.unitaOrganizzativa → string, default '1'
protocollo.mittenteDenominazione → string, default '' (nome ente, es. "Comune di Montesilvano")
```

Tab "Protocollo" in `apps/frontend-admin/src/App.tsx` (righe ~5379+, oggi
usa `localStorage` via `settProto*`/`sett_proto_*`): riscritto per seguire
esattamente il pattern degli altri tab (state da `s['protocollo.*']` nel
load, `buildSettingsPayload()` per il save, niente più `localStorage`).
Dropdown "Provider" mantenuto ma con **solo l'opzione "TINN"** — le altre
label placeholder (Maggioli/Saga/Halley/Custom) rimosse perché non hanno mai
avuto un connettore reale dietro.

## Wizard — campo "Protocolla questo invio"

Nuovo checkbox nello step canale del wizard (`frontend-admin/src/App.tsx`,
stesso step dove oggi si configurano gli altri campi per-canale):
- Per **SEND**: checked e disabilitato, testo esplicativo "Obbligatorio per
  SEND: ogni invio viene registrato sul Protocollo Informatico prima della
  trasmissione."
- Per altri canali (PEC/Email/AppIO/Postale): libero, default unchecked.

Salvato in `campaign.channelConfig.protocolla: boolean`. Letto da ogni
channel strategy che lo consulta (in questo sotto-progetto: solo
`SendStrategy` lo consuma davvero; per gli altri canali il campo esiste già
in UI/dati ma la chiamata al connettore da dentro le altre strategy è fuori
scope qui — verrà aggiunta quando servirà, non a scopo speculativo).

## Dati — dove va il risultato

Nessuna nuova colonna/migration. Il risultato della protocollazione viene
scritto in `NotificationAttempt.responsePayload.protocollo`:

```json
{ "numeroProtocollo": 12345, "annoProtocollo": 2026, "dataProtocollazione": "13/07/2026" }
```

Scritto dalla strategy **prima** di costruire il payload del canale (per
SEND, l'esito alimenta poi `paProtocolNumber` nel sotto-progetto 2 — fuori
scope qui, ma il dato sarà già disponibile in `responsePayload`).

## Gestione errori

Se `protocolla=true` e una qualunque delle tre chiamate SOAP fallisce
(`lngErrNumber != 0`, errore HTTP, rete, timeout, parsing risposta non
valida): l'intero tentativo per quel destinatario fallisce — stesso pattern
già in uso (`throw new Error(...)` dentro `strategy.send()` → l'attempt
risulta `failed` con `errorMessage` leggibile). Nessun invio "silenzioso"
senza protocollo quando richiesto: per SEND questo blocca l'invio stesso
(coerente con l'obbligatorietà).

## Verifica

L'endpoint fornito è **produzione reale** (host non riportato in questo
documento, vedi nota su credenziali sopra): niente chiamate automatiche
ripetute in CI/test contro di esso.

- Unit test (`protocollo.service.spec.ts`) con `fetch` mockato: verificano
  la corretta costruzione dell'envelope SOAP/XML Segnatura, il parsing della
  risposta (successo ed errore `lngErrNumber != 0`), il comportamento di
  cache/retry del DST.
- Un singolo test manuale guidato con l'utente presente, contro l'endpoint
  reale, per validare l'ipotesi sul formato (base64 inline vs MIME) prima di
  considerare l'integrazione completa.
- `tsc --noEmit` backend/frontend, `jest --maxWorkers=2` (nessuna regressione
  sul resto della suite).

## File coinvolti

- `apps/backend/src/protocollo/protocollo.service.ts` (nuovo)
- `apps/backend/src/protocollo/protocollo.service.spec.ts` (nuovo)
- `apps/backend/src/protocollo/protocollo.module.ts` (nuovo)
- `apps/backend/src/settings/settings.registry.ts` (nuove chiavi `protocollo.*`)
- `apps/backend/src/settings/settings.module.ts` (import eventuale se serve DI)
- `apps/frontend-admin/src/App.tsx` (tab Protocollo reale, checkbox wizard
  "Protocolla questo invio", state/load/save)
- `apps/backend/src/channels/send/send.strategy.ts` (consumo del checkbox
  `protocolla`, chiamata a `ProtocolloService.protocolla()` prima
  dell'invio placeholder — il collegamento con `paProtocolNumber` reale
  resta nel sotto-progetto 2)
