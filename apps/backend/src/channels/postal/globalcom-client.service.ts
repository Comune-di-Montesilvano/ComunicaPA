import { Injectable } from '@nestjs/common';
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
  servizio: 'Lettera' | 'Raccomandata';
  ricevutaDiRitorno: boolean;
  mittente: GbcAddress | null;
  destinatario: GbcAddress;
  note: string;
  protocollo?: string;
  centroDiCosto?: string;
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
  private async createSession(creds: GbcCredentials): Promise<soap.Client> {
    // baseUrl configurabile da UI: normalizza un eventuale "?wsdl" già
    // presente (operatore che ha incollato l'URL così come appare nel
    // browser durante il test del WSDL) per evitare "...asmx?wsdl?wsdl" e
    // un endpoint SOAP reale sbagliato per le chiamate successive al Login.
    const endpoint = creds.baseUrl.replace(/\?wsdl$/i, '');
    const client = await soap.createClientAsync(`${endpoint}?wsdl`, { endpoint });
    const [loginResult] = await client.LoginAsync({ user: creds.user, password: creds.password, gruppo: creds.group });
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

    const invio: Record<string, unknown> = {
      Servizio: params.servizio,
      RicevutaDiRitorno: params.ricevutaDiRitorno,
      Destinatari: [toInfoIndirizzoExt(params.destinatario)],
      Note: params.note,
      Files: [{
        file: params.fileBuffer.toString('base64'),
        filetype: 'pdf',
        MD5: md5,
        isreceipt: false,
        issigned: false,
      }],
      ...(params.mittente ? { Mittente: toInfoIndirizzoExt(params.mittente) } : { UsaMittentePredefinito: true }),
      ...(params.protocollo ? { Protocollo: params.protocollo } : {}),
      ...(params.centroDiCosto ? { CentrodiCosto: params.centroDiCosto } : {}),
      ...(params.userData1 ? { UserData1: params.userData1 } : {}),
    };

    const [result] = await (client as any).invio_ext_singoloAsync({ Invio: invio });
    if (!result.Result) {
      throw new Error(`invio_ext_singolo fallito: ${result.Messaggio || 'errore sconosciuto'}`);
    }
    return mapDocStatus(result.Risposta);
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
    if (!result.Result || !result.Risposta) return null;
    return mapDocStatus(result.Risposta);
  }
}
