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
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] : '';
}

@Injectable()
export class ProtocolloService {
  private readonly logger = new Logger(ProtocolloService.name);
  private cachedDst: string | null = null;

  constructor(private readonly settings: AppSettingsService) {}

  private async getConfig(): Promise<ProtocolloConfig> {
    const [baseUrl, codiceEnte, username, password, codiceTitolario, codiceAmministrazione, unitaOrganizzativa, mittenteDenominazione] = await Promise.all([
      this.settings.get<string>('protocollo.baseUrl' as SettingKey),
      this.settings.get<string>('protocollo.codiceEnte' as SettingKey),
      this.settings.get<string>('protocollo.username' as SettingKey),
      this.settings.get<string>('protocollo.password' as SettingKey),
      this.settings.get<string>('protocollo.codiceTitolario' as SettingKey),
      this.settings.get<string>('protocollo.codiceAmministrazione' as SettingKey),
      this.settings.get<string>('protocollo.unitaOrganizzativa' as SettingKey),
      this.settings.get<string>('protocollo.mittenteDenominazione' as SettingKey),
    ]);
    const missing = Object.entries({ baseUrl, codiceEnte, username, password })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(`Configurazione Protocollo incompleta: mancano ${missing.join(', ')}`);
    }
    return { baseUrl, codiceEnte, username, password, codiceTitolario, codiceAmministrazione, unitaOrganizzativa, mittenteDenominazione };
  }

  private async soapCall(baseUrl: string, soapAction: string, body: string): Promise<string> {
    const envelope = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body>${body}</soap:Body></soap:Envelope>`;
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `"http://tempuri.org/#${soapAction}"`,
      },
      body: envelope,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Chiamata Protocollo (${soapAction}) fallita: HTTP ${response.status} — ${text.slice(0, 500)}`);
    }
    return text;
  }

  /** Esegue il login (o riusa il DST in cache) e ritorna il token di sessione. */
  async login(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cachedDst) {
      return this.cachedDst;
    }
    const config = await this.getConfig();
    const body = `<Login xmlns="http://tempuri.org/"><CodiceEnte>${xmlEscape(config.codiceEnte)}</CodiceEnte><Username>${xmlEscape(config.username)}</Username><UserPassword>${xmlEscape(config.password)}</UserPassword></Login>`;
    const responseXml = await this.soapCall(config.baseUrl, 'Login', body);

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

  clearCache(): void {
    this.cachedDst = null;
  }
}
