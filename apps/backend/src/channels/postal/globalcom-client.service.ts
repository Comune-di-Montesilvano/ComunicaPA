import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as soap from 'soap';

export interface GbcAddress {
  denominazione1: string;
  denominazione2?: string;
  indirizzo1: string;
  indirizzo2?: string;
  cap?: string;
  citta: string;
  provincia?: string;
}

export interface GbcCredentials {
  baseUrl: string;
  user: string;
  password: string;
  group: string;
}

export interface GbcInvioParams {
  // Non ristretto a Lettera/Raccomandata: alcune utenze sono abilitate solo
  // su varianti "Market"/"Contest" (es. RaccomandataMarket4, LetteraContest4
  // — canale Postel/Irideos), verificato con l'errore reale "L'utente non è
  // autorizzato ad inviare documenti di questo tipo" su Lettera/Raccomandata
  // standard per un'utenza abilitata solo sul tier Market.
  servizio: string;
  ricevutaDiRitorno: boolean;
  /** Stampa a colori (InfoGUIDExt.Colore, campo obbligatorio nel WSDL — sempre inviato). */
  colore: boolean;
  /** Stampa fronte-retro (InfoGUIDExt.FronteRetro, campo obbligatorio nel WSDL — sempre inviato). */
  fronteRetro: boolean;
  mittente: GbcAddress | null;
  /** Destinatario della cartolina AR (InfoIndirizzoExt "Ricevuta") — rilevante solo se ricevutaDiRitorno=true. */
  ricevuta?: GbcAddress | null;
  destinatario: GbcAddress;
  note: string;
  protocollo?: string;
  centroDiCosto?: string;
  // Obbligatorio per i Servizio "Market"/"Contest" (vedi commento su
  // settings.registry.ts 'postal.codiceContratto').
  codiceContratto?: string;
  userData1?: string;
  fileBuffer: Buffer;
}

export interface GbcDocStatus {
  idPro: string;
  stato: string;
  codiceErrore?: string;
  descrizione?: string;
  /** Costo netto reale in euro (Risposta.Valori.Costo) — null se Valori assente (es. risposta di errore). */
  costoNetto: number | null;
  numeroPagine: number | null;
  /** true = invio nazionale, false = estero (Risposta.Nazionale). */
  nazionale: boolean | null;
  importoPostaleNetto: number | null;
  importoStampaNetto: number | null;
  importoARNetto: number | null;
  tipoDocumento: string | null;
  codiceContratto: string | null;
}

export interface GbcContratto {
  codiceContratto: string;
  descrizione: string;
  tipologia: string;
}

export interface GbcInfoUtenza {
  operazioneRiuscita: boolean;
  messaggioErrore?: string;
  centroDiCosto?: string;
  /** ServiceType leggibili/inviabili dall'utenza — popola il dropdown del wizard campagna. */
  prodottiDisponibili: string[];
  /** Codici contratto disponibili per i Servizio Market/Contest/Atto Giudiziario. */
  contratti: GbcContratto[];
}

function toInfoIndirizzoExt(addr: GbcAddress): Record<string, unknown> {
  return {
    Denominazione1: addr.denominazione1,
    ...(addr.denominazione2 ? { Denominazione2: addr.denominazione2 } : {}),
    Indirizzo1: addr.indirizzo1,
    ...(addr.indirizzo2 ? { Indirizzo2: addr.indirizzo2 } : {}),
    ...(addr.cap ? { CAP: addr.cap } : {}),
    Citta: addr.citta,
    ...(addr.provincia ? { Provincia: addr.provincia } : {}),
  };
}

export function mapDocStatus(raw: any): GbcDocStatus {
  const valori = raw.Valori;
  const billing = valori?.DettaglioBilling;
  return {
    idPro: raw.IDPRO,
    stato: raw.Stato,
    codiceErrore: raw.CodiceErrore,
    descrizione: raw.Descrizione,
    costoNetto: valori?.Costo ?? null,
    numeroPagine: valori?.NumeroPagine ?? null,
    nazionale: raw.Nazionale ?? null,
    importoPostaleNetto: billing?.ImportoPostaleNetto ?? null,
    importoStampaNetto: billing?.ImportoStampaNetto ?? null,
    importoARNetto: billing?.ImportoARNetto ?? null,
    tipoDocumento: raw.TipoDocumento ?? null,
    codiceContratto: raw.CodiceContratto ?? null,
  };
}

/**
 * Unico punto che parla con il web service SOAP GlobalCom
 * (corrispondenzadigitale.it). Sessione a cookie ASP.NET: un client nuovo
 * per ogni operazione, Login seguito dalla chiamata reale sullo stesso
 * client — nessun riuso di sessione fra richieste diverse (stateless fra
 * pod). Verificato sul manuale tecnico ufficiale GlobalCom v5.26.
 */
@Injectable()
export class GlobalComClient {
  private readonly logger = new Logger(GlobalComClient.name);

  private async createSession(creds: GbcCredentials): Promise<soap.Client> {
    // baseUrl configurabile da UI: normalizza un eventuale "?wsdl" già
    // presente (operatore che ha incollato l'URL così come appare nel
    // browser durante il test del WSDL) per evitare "...asmx?wsdl?wsdl" e
    // un endpoint SOAP reale sbagliato per le chiamate successive al Login.
    const endpoint = creds.baseUrl.replace(/\?wsdl$/i, '');
    this.logger.debug(`createSession: WSDL=${endpoint}?wsdl, endpoint=${endpoint}, user=${creds.user}, group=${creds.group}`);
    const client = await soap.createClientAsync(`${endpoint}?wsdl`, { endpoint });
    this.logger.debug('createSession: client SOAP creato, chiamo LoginAsync...');
    let loginResult: any;
    try {
      // Nome parametro WSDL reale: "group" (inglese) — il manuale tecnico
      // usa "gruppo" solo nel testo descrittivo italiano e nell'esempio C#
      // (parametro posizionale, nome locale irrilevante). Con "gruppo" il
      // valore non arriva mai al server (elemento "group" resta assente/
      // null), causando un NullReferenceException lato GlobalCom
      // indipendentemente dal valore configurato in postal.group — bug
      // reale riscontrato in test con credenziali vere, verificato
      // scaricando l'XSD della Login request dal WSDL live.
      [loginResult] = await client.LoginAsync({ user: creds.user, password: creds.password, group: creds.group });
    } catch (err: any) {
      // MAI loggare (client as any).lastRequest qui: il body SOAP di Login
      // contiene la password in chiaro (<password>...</password>) — solo la
      // risposta (che non la contiene mai) è sicura da loggare.
      this.logger.debug(`createSession: LoginAsync HA LANCIATO — response XML: ${(client as any).lastResponse}`);
      throw err;
    }
    this.logger.debug(`createSession: LoginAsync risposta = ${JSON.stringify(loginResult)}`);
    if (!loginResult.LoginResult) {
      // Il messaggio è quello letterale del server GlobalCom — verificato in
      // test reale che risponde con lo stesso identico testo ("La
      // combinazione di utente e gruppo non è valida") sia per uno username/
      // gruppo effettivamente sbagliato sia per una password errata: non
      // distingue le due cause lato loro. Nota aggiunta per non far perdere
      // tempo a controllare solo utente/gruppo quando la causa più comune è
      // la password.
      throw new Error(`Login GlobalCom fallito: ${loginResult.message || 'credenziali non valide'} (verifica anche la password, non solo utente/gruppo — GlobalCom usa lo stesso messaggio per entrambe le cause)`);
    }
    const setCookie = (client as any).lastResponseHeaders?.['set-cookie'];
    if (setCookie) {
      const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
        .map((c: string) => c.split(';')[0])
        .join('; ');
      client.addHttpHeader('Cookie', cookie);
    }
    return client;
  }

  async invioExtSingolo(creds: GbcCredentials, params: GbcInvioParams): Promise<GbcDocStatus> {
    const client = await this.createSession(creds);
    const md5 = crypto.createHash('md5').update(params.fileBuffer).digest('hex').toUpperCase();

    // Destinatari/Files sono tipi WSDL "ArrayOfX" (ArrayOfInfoIndirizzoExt/
    // ArrayOfInfoFileExt): l'elemento ripetuto dentro il contenitore si
    // chiama come il TIPO dell'item (InfoIndirizzoExt/InfoFileExt), non
    // come il campo array stesso — verificato sull'XSD del WSDL live.
    // Passare un array JS nudo (senza questo wrapper) fa sì che node-soap
    // non sappia come nominare l'elemento ripetuto: il server riceve un
    // <Destinatari> vuoto/non riconosciuto e risponde "Il documento
    // inserito deve contenere almeno un destinatario" anche quando un
    // destinatario è stato effettivamente passato (bug reale riscontrato
    // in test con GlobalCom, indipendente dal Servizio usato).
    const invio: Record<string, unknown> = {
      Servizio: params.servizio,
      RicevutaDiRitorno: params.ricevutaDiRitorno,
      Colore: params.colore,
      FronteRetro: params.fronteRetro,
      Destinatari: { InfoIndirizzoExt: [toInfoIndirizzoExt(params.destinatario)] },
      Note: params.note,
      Files: { InfoFileExt: [{
        file: params.fileBuffer.toString('base64'),
        filetype: 'pdf',
        MD5: md5,
        isreceipt: false,
        issigned: false,
      }] },
      ...(params.mittente ? { Mittente: toInfoIndirizzoExt(params.mittente) } : { UsaMittentePredefinito: true }),
      // Con RicevutaDiRitorno=true, GlobalCom richiede un destinatario esplicito
      // per la cartolina AR (campo "Ricevuta", InfoIndirizzoExt) — se non
      // passato, il default WSDL è un indirizzo vuoto, non l'utenza mittente:
      // rigettato con "Destinatario ricevuta: I campi Denominazione1 e
      // Denominazione2 sono entrambi vuoti" (errore reale riscontrato in test).
      // UsaDestinatarioARPredefinito presuppone un indirizzo AR predefinito
      // configurato lato GlobalCom sull'utenza — non è il caso generale (errore
      // reale riscontrato: "richiesto il destinatario AR predefinito... ma non
      // è presente in archivio"), quindi si passa sempre un indirizzo esplicito
      // quando disponibile (params.ricevuta, tipicamente = mittente configurato:
      // la cartolina AR torna al mittente), col flag predefinito come ultima
      // spiaggia solo se non c'è alcun indirizzo noto lato nostro.
      ...(params.ricevutaDiRitorno
        ? (params.ricevuta ? { Ricevuta: toInfoIndirizzoExt(params.ricevuta) } : { UsaDestinatarioARPredefinito: true })
        : {}),
      ...(params.protocollo ? { Protocollo: params.protocollo } : {}),
      ...(params.centroDiCosto ? { CentrodiCosto: params.centroDiCosto } : {}),
      ...(params.codiceContratto ? { CodiceContratto: params.codiceContratto } : {}),
      ...(params.userData1 ? { UserData1: params.userData1 } : {}),
    };

    try {
      const [result] = await (client as any).invio_ext_singoloAsync({ Invio: invio });
      this.logger.debug(`invio_ext_singolo request: ${(client as any).lastRequest}`);
      // Convenzione WSDL ASMX: il campo booleano di esito si chiama
      // "<nomeMetodo>Result" (es. LoginResult per Login), non "Result"
      // generico — verificato su una risposta reale (invio_ext_singoloResult
      // true, Stato=Accettato, IDPRO reale assegnato) che il nostro vecchio
      // controllo "result.Result" leggeva sempre undefined/falsy, marcando
      // FAILED anche un invio realmente accettato da GlobalCom (bug critico,
      // rischio di doppio invio su un retry successivo se non corretto).
      if (!result.invio_ext_singoloResult) {
        // Il dettaglio utile (CodiceErrore/Descrizione, es. "L'utente non è
        // autorizzato ad inviare documenti di questo tipo") arriva spesso
        // dentro Risposta anche quando Result=false, non in Messaggio (che
        // può restare vuoto) — verificato su un errore reale (0401).
        const risposta = result.Risposta as { CodiceErrore?: string; Descrizione?: string } | undefined;
        const dettaglio = result.Messaggio || risposta?.Descrizione || risposta?.CodiceErrore || 'errore sconosciuto';
        throw new Error(`invio_ext_singolo fallito: ${dettaglio}`);
      }
      return mapDocStatus(result.Risposta);
    } catch (err) {
      // Log diagnostico: XML grezzo inviato/ricevuto, utile per un SOAP
      // Fault server-side (es. NullReferenceException lato GlobalCom) dove
      // il messaggio d'errore da solo non basta a capire quale campo del
      // payload lo scatena. Solo a LOG_LEVEL=debug (vedi CLAUDE.md).
      this.logger.debug(`invio_ext_singolo FALLITO — request XML: ${(client as any).lastRequest}`);
      this.logger.debug(`invio_ext_singolo FALLITO — response XML: ${(client as any).lastResponse}`);
      throw err;
    }
  }

  /** Ricerca testuale su PROTOCOLLO/LOTTO/NOTE — usata per il dedup su retry. */
  async cercaPerTesto(creds: GbcCredentials, testo: string): Promise<GbcDocStatus[]> {
    const client = await this.createSession(creds);
    const [result] = await (client as any).lista_documentiAsync({
      Filtri: { Testo: testo, SoloTesto: true, Limite: 1 },
    });
    const risposta = result.Risposta;
    if (!risposta) return [];
    const list = Array.isArray(risposta) ? risposta : [risposta];
    return list.map(mapDocStatus);
  }

  /** Poll-stato dedicato (manuale §2.2.10) — non presente nel solo WSDL. */
  async dettagliDocumento(creds: GbcCredentials, idPro: string): Promise<GbcDocStatus | null> {
    const client = await this.createSession(creds);
    const [result] = await (client as any).dettagli_documentoAsync({ IDPRO: idPro });
    if (!result.dettagli_documentoResult || !result.Risposta) return null;
    return mapDocStatus(result.Risposta);
  }

  /**
   * Audit permessi/contratti dell'utenza (manuale §2.2.60) — solo
   * informativo, nessun invio: usato dal tasto "Test" del provider per
   * scoprire automaticamente quali Servizio l'utenza può davvero inviare e
   * con quali codici contratto, invece di farli configurare a mano
   * (verificato in test reale: un'utenza può essere abilitata solo su
   * varianti Market/Contest, mai su Lettera/Raccomandata standard, e i
   * codici contratto sono specifici per utenza — nessun default valido).
   */
  async informazioniUtenza(creds: GbcCredentials): Promise<GbcInfoUtenza> {
    const client = await this.createSession(creds);
    const [result] = await (client as any).InformazioniUtenzaAsync({});
    const info = result.InformazioniUtenzaResult as Record<string, unknown>;
    if (!info?.['OperazioneRiuscita']) {
      return {
        operazioneRiuscita: false,
        messaggioErrore: (info?.['MessaggioErrore'] as string) || 'Recupero informazioni utenza fallito',
        prodottiDisponibili: [],
        contratti: [],
      };
    }
    // ProdottiDisponibili/ContrattiH2H sono tipi WSDL "ArrayOfX" anche in
    // risposta (ArrayOfServiceType/ArrayOfDatiContrattoCOLMOLExt): l'elemento
    // ripetuto sta dentro un wrapper con il nome del TIPO, non del campo —
    // stesso pattern verificato per Destinatari/Files in invioExtSingolo.
    const prodottiWrapper = info['ProdottiDisponibili'] as { ServiceType?: string | string[] } | undefined;
    const prodotti = prodottiWrapper?.ServiceType;
    const prodottiDisponibili = Array.isArray(prodotti) ? prodotti : prodotti ? [prodotti] : [];
    const contrattiWrapper = info['ContrattiH2H'] as {
      DatiContrattoCOLMOLExt?:
        | { CodiceContratto?: string; Descrizione?: string; Tipologia?: string }
        | Array<{ CodiceContratto?: string; Descrizione?: string; Tipologia?: string }>;
    } | undefined;
    const contrattiRaw = contrattiWrapper?.DatiContrattoCOLMOLExt;
    const contrattiList = Array.isArray(contrattiRaw) ? contrattiRaw : contrattiRaw ? [contrattiRaw] : [];
    return {
      operazioneRiuscita: true,
      centroDiCosto: (info['CentroDiCosto'] as string) || undefined,
      prodottiDisponibili: prodottiDisponibili as string[],
      contratti: contrattiList.map((c) => ({
        codiceContratto: c.CodiceContratto || '',
        descrizione: c.Descrizione || '',
        tipologia: c.Tipologia || '',
      })),
    };
  }
}
