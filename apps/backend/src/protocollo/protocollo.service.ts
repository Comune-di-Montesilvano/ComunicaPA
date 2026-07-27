import { Injectable, Logger } from '@nestjs/common';
import { AppSettingsService } from '../settings/app-settings.service';
import type { SettingKey } from '../settings/settings.registry';

interface ProtocolloConfig {
  baseUrl: string;
  codiceEnte: string;
  username: string;
  password: string;
  codiceTitolario: string;
  codiceAmministrazione: string;
  unitaOrganizzativa: string;
  mittenteDenominazione: string;
  timeoutMs: number;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extractTag(xml: string, tag: string): string {
  // Il servizio serializza in stile SOAP RPC/encoded: i tag possono avere
  // attributi (es. <strDST xsi:type="xsd:string">valore</strDST>).
  const match = xml.match(new RegExp(`<[\\w:]*${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</[\\w:]*${tag}>`));
  return match ? match[1] : '';
}

export interface ProtocollaAllegato {
  buffer: Buffer;
  filename: string;
  oggetto: string;
}

export interface ProtocollaInput {
  oggetto: string;
  destinatario: { codiceFiscale: string; nome: string; cognome: string; denominazione: string };
  documentBuffer: Buffer;
  documentFilename: string;
  allegati?: ProtocollaAllegato[];
}

export interface ProtocollaResult {
  numeroProtocollo: number;
  annoProtocollo: number;
  dataProtocollazione: string;
}

@Injectable()
export class ProtocolloService {
  private readonly logger = new Logger(ProtocolloService.name);
  private cachedDst: string | null = null;

  constructor(private readonly settings: AppSettingsService) {}

  private async getConfig(): Promise<ProtocolloConfig> {
    const [
      baseUrl,
      codiceEnte,
      username,
      password,
      codiceTitolario,
      codiceAmministrazione,
      unitaOrganizzativa,
      mittenteDenominazione,
      timeoutSetting,
    ] = await Promise.all([
      this.settings.get<string>('protocollo.baseUrl' as SettingKey),
      this.settings.get<string>('protocollo.codiceEnte' as SettingKey),
      this.settings.get<string>('protocollo.username' as SettingKey),
      this.settings.get<string>('protocollo.password' as SettingKey),
      this.settings.get<string>('protocollo.codiceTitolario' as SettingKey),
      this.settings.get<string>('protocollo.codiceAmministrazione' as SettingKey),
      this.settings.get<string>('protocollo.unitaOrganizzativa' as SettingKey),
      this.settings.get<string>('protocollo.mittenteDenominazione' as SettingKey),
      this.settings.get<number>('protocollo.timeoutMs' as SettingKey).catch(() => null),
    ]);
    const missing = Object.entries({ baseUrl, codiceEnte, username, password })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(`Configurazione Protocollo incompleta: mancano ${missing.join(', ')}`);
    }
    const timeoutMs = typeof timeoutSetting === 'number' && timeoutSetting > 0 ? timeoutSetting : 120000;
    return { baseUrl, codiceEnte, username, password, codiceTitolario, codiceAmministrazione, unitaOrganizzativa, mittenteDenominazione, timeoutMs };
  }

  /** Il WSDL espone il servizio su /soap/DOCAREAProto: l'utente configura solo l'host. */
  private serviceUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/$/, '')}/soap/DOCAREAProto`;
  }

  private async soapCall(baseUrl: string, soapAction: string, body: string, timeoutMs = 120000, maxRetries = 2): Promise<string> {
    const envelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body>${body}</soap:Body></soap:Envelope>`;
    const url = this.serviceUrl(baseUrl);

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        this.logger.warn(`Tentativo ${attempt}/${maxRetries} per chiamare Protocollo SOAP ${soapAction}...`);
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            SOAPAction: `"http://tempuri.org/#${soapAction}"`,
          },
          body: envelope,
          signal: AbortSignal.timeout(timeoutMs),
        });

        const text = await response.text();
        if (!response.ok) {
          const cleanText = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
          const err = new Error(`Chiamata Protocollo (${soapAction}) fallita: HTTP ${response.status} — ${cleanText}`);
          if ([500, 502, 503, 504].includes(response.status) && attempt < maxRetries) {
            this.logger.warn(`HTTP ${response.status} durante ${soapAction} (proxy/server temporaneamente non disponibile). Eseguo retry...`);
            lastError = err;
            continue;
          }
          throw err;
        }
        return text;
      } catch (err: any) {
        const isAbort = err.name === 'TimeoutError' || err.name === 'AbortError' || err.message?.includes('timeout');
        const isNetworkErr = err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNREFUSED';
        if ((isAbort || isNetworkErr) && attempt < maxRetries) {
          this.logger.warn(`Errore di connessione/timeout (${err.message}) durante ${soapAction}. Eseguo retry...`);
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError || new Error(`Chiamata Protocollo (${soapAction}) fallita dopo ${maxRetries} tentativi.`);
  }

  /** Esegue il login (o riusa il DST in cache) e ritorna il token di sessione. */
  async login(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cachedDst) {
      return this.cachedDst;
    }
    const config = await this.getConfig();
    const body = `<Login xmlns="http://tempuri.org/"><CodiceEnte>${xmlEscape(config.codiceEnte)}</CodiceEnte><Username>${xmlEscape(config.username)}</Username><UserPassword>${xmlEscape(config.password)}</UserPassword></Login>`;
    const responseXml = await this.soapCall(config.baseUrl, 'Login', body, config.timeoutMs);

    const errNumber = extractTag(responseXml, 'IngErrNumber');
    const errString = extractTag(responseXml, 'strErrString');
    if (errNumber && errNumber !== '0') {
      throw new Error(`Login Protocollo fallito (${errNumber}): ${errString || 'errore sconosciuto'}`);
    }
    const dst = extractTag(responseXml, 'strDST');
    if (!dst) {
      throw new Error(`Login Protocollo: risposta priva di strDST — ${responseXml.slice(0, 300)}`);
    }
    this.cachedDst = dst;
    this.logger.log('Login Protocollo eseguito, DST ottenuto');
    return dst;
  }

  private async inserimento(config: ProtocolloConfig, dst: string, fileBuffer: Buffer): Promise<number> {
    const base64 = fileBuffer.toString('base64');
    const body = `<Inserimento xmlns="http://tempuri.org/"><Username>${xmlEscape(config.username)}</Username><DSTLogin>${xmlEscape(dst)}</DSTLogin><FileBinario>${base64}</FileBinario></Inserimento>`;
    const responseXml = await this.soapCall(config.baseUrl, 'Inserimento', body, config.timeoutMs);

    const errNumber = extractTag(responseXml, 'IngErrNumber');
    const errString = extractTag(responseXml, 'strErrString');
    if (errNumber && errNumber !== '0') {
      throw new Error(`Inserimento Protocollo fallito (${errNumber}): ${errString || 'errore sconosciuto'}`);
    }
    const docId = extractTag(responseXml, 'IngDocID');
    if (!docId) {
      throw new Error(`Inserimento Protocollo: risposta priva di IngDocID — ${responseXml.slice(0, 300)}`);
    }
    return Number(docId);
  }

  private buildSegnatura(config: ProtocolloConfig, input: ProtocollaInput, docId: number, allegatoIds: number[] = []): string {
    const { destinatario } = input;
    let allegatiXml = '';
    if (input.allegati && input.allegati.length > 0) {
      allegatiXml += '<Allegati>';
      input.allegati.forEach((a, idx) => {
        const aId = allegatoIds[idx];
        allegatiXml += `<Documento id="${aId}" nome="${xmlEscape(a.filename)}"><DescrizioneDocumento>${xmlEscape(a.oggetto)}</DescrizioneDocumento></Documento>`;
      });
      allegatiXml += '</Allegati>';
    }
    return `<?xml version="1.0" encoding="utf-8"?><Segnatura versione="2001-05-07" xml:lang="it"><Intestazione><Oggetto>${xmlEscape(input.oggetto)}</Oggetto><Identificatore><NumeroRegistrazione>0</NumeroRegistrazione><DataRegistrazione>0</DataRegistrazione><Flusso>U</Flusso></Identificatore><Mittente><Amministrazione><Denominazione>${xmlEscape(config.mittenteDenominazione)}</Denominazione><IndirizzoTelematico tipo="smtp"></IndirizzoTelematico><UnitaOrganizzativa id="${xmlEscape(config.unitaOrganizzativa)}" /></Amministrazione></Mittente><Destinatario><Persona id="${xmlEscape(destinatario.codiceFiscale)}"><Nome>${xmlEscape(destinatario.nome)}</Nome><Cognome>${xmlEscape(destinatario.cognome)}</Cognome><CodiceFiscale>${xmlEscape(destinatario.codiceFiscale)}</CodiceFiscale><Denominazione>${xmlEscape(destinatario.denominazione)}</Denominazione><IndirizzoTelematico tipo="smtp"></IndirizzoTelematico></Persona></Destinatario><Classifica><CodiceAmministrazione>${xmlEscape(config.codiceAmministrazione)}</CodiceAmministrazione><CodiceTitolario>${xmlEscape(config.codiceTitolario)}</CodiceTitolario></Classifica></Intestazione><Descrizione><Documento id="${docId}" nome="${xmlEscape(input.documentFilename)}"><DescrizioneDocumento>${xmlEscape(input.oggetto)}</DescrizioneDocumento></Documento>${allegatiXml}</Descrizione></Segnatura>`;
  }

  private async protocollazione(config: ProtocolloConfig, dst: string, segnaturaXml: string): Promise<ProtocollaResult> {
    const base64 = Buffer.from(segnaturaXml, 'utf-8').toString('base64');
    const body = `<Protocollazione xmlns="http://tempuri.org/"><Username>${xmlEscape(config.username)}</Username><DSTLogin>${xmlEscape(dst)}</DSTLogin><FileXML>${base64}</FileXML></Protocollazione>`;
    const responseXml = await this.soapCall(config.baseUrl, 'Protocollazione', body, config.timeoutMs);

    const errNumber = extractTag(responseXml, 'IngErrNumber');
    const errString = extractTag(responseXml, 'strErrString');
    if (errNumber && errNumber !== '0') {
      throw new Error(`Protocollazione fallita (${errNumber}): ${errString || 'errore sconosciuto'}`);
    }
    return {
      numeroProtocollo: Number(extractTag(responseXml, 'IngNumPG')),
      annoProtocollo: Number(extractTag(responseXml, 'IngAnnoPG')),
      dataProtocollazione: extractTag(responseXml, 'StrDataPG'),
    };
  }

  /** Orchestratore: login (se serve) → Inserimento → Protocollazione (Flusso=U). */
  async protocolla(input: ProtocollaInput): Promise<ProtocollaResult> {
    const config = await this.getConfig();
    let dst = await this.login();
    
    let docId: number;
    try {
      docId = await this.inserimento(config, dst, input.documentBuffer);
    } catch (err: any) {
      if (err.message.includes('DST non valido') || err.message.includes('sessione scaduta') || err.message.includes('(-2)')) {
        this.logger.warn('DST scaduto o non valido: eseguo relogin e riprovo inserimento principale...');
        dst = await this.login(true);
        docId = await this.inserimento(config, dst, input.documentBuffer);
      } else {
        throw err;
      }
    }
    
    const allegatoIds: number[] = [];
    if (input.allegati && input.allegati.length > 0) {
      for (const a of input.allegati) {
        let aId: number;
        try {
          aId = await this.inserimento(config, dst, a.buffer);
        } catch (err: any) {
          if (err.message.includes('DST non valido') || err.message.includes('sessione scaduta') || err.message.includes('(-2)')) {
            this.logger.warn('DST scaduto o non valido durante allegati: eseguo relogin e riprovo...');
            dst = await this.login(true);
            aId = await this.inserimento(config, dst, a.buffer);
          } else {
            throw err;
          }
        }
        allegatoIds.push(aId);
      }
    }

    const segnaturaXml = this.buildSegnatura(config, input, docId, allegatoIds);
    let result: ProtocollaResult;
    try {
      result = await this.protocollazione(config, dst, segnaturaXml);
    } catch (err: any) {
      if (err.message.includes('DST non valido') || err.message.includes('sessione scaduta') || err.message.includes('(-2)')) {
        this.logger.warn('DST scaduto o non valido durante protocollazione: eseguo relogin e riprovo...');
        dst = await this.login(true);
        result = await this.protocollazione(config, dst, segnaturaXml);
      } else {
        throw err;
      }
    }
    this.logger.log(`Protocollazione OK: ${result.numeroProtocollo}/${result.annoProtocollo}`);
    return result;
  }

  clearCache(): void {
    this.cachedDst = null;
  }
}
