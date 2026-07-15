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
  mittente: GbcAddress | null;
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

function mapDocStatus(raw: any): GbcDocStatus {
  return {
    idPro: raw.IDPRO,
    stato: raw.Stato,
    codiceErrore: raw.CodiceErrore,
    descrizione: raw.Descrizione,
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
      throw new Error(`Login GlobalCom fallito: ${loginResult.message || 'credenziali non valide'}`);
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
}
