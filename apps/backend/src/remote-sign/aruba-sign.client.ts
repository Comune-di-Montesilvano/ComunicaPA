import { Injectable, Logger } from '@nestjs/common';
import * as soap from 'soap';
import { AppSettingsService } from '../settings/app-settings.service.js';
import type { SettingKey } from '../settings/settings.registry.js';
import { classifyArssError, RemoteSignError } from './arss-errors.js';

export interface ArssCredentials {
  user: string;
  password: string;
}

/** Stessi default di settings.registry.ts (remoteSign.*). */
const DEFAULT_WSDL_URL = 'https://arss.arubapec.it/ArubaSignService/ArubaSignService?wsdl';

/**
 * Client SOAP Aruba Remote Sign Service (ARSS). Flusso verificato dal vivo
 * (spike 2026-10-13, docs/claude/remote-sign.md): opensession con OTP →
 * pdfsignatureV2 con session_id (identity senza otpPwd) → closesession.
 * MAI loggare password, OTP, sessionid o binari.
 */
@Injectable()
export class ArubaSignClient {
  private readonly logger = new Logger(ArubaSignClient.name);

  /** Client SOAP per URL WSDL: il WSDL si scarica una volta, non a ogni chiamata. */
  private cache: { url: string; client: Promise<any> } | null = null;

  constructor(private readonly settings: AppSettingsService) {}

  /** Impostazione vuota (salvata in bianco da UI) → default del registry. */
  private async setting(key: SettingKey, fallback: string): Promise<string> {
    return String((await this.settings.get<string>(key)) ?? '').trim() || fallback;
  }

  private async client(): Promise<any> {
    const wsdlUrl = await this.setting('remoteSign.wsdlUrl', DEFAULT_WSDL_URL);
    if (this.cache?.url !== wsdlUrl) {
      const client = soap.createClientAsync(wsdlUrl, { endpoint: wsdlUrl.replace(/\?wsdl$/i, '') });
      const entry = { url: wsdlUrl, client };
      this.cache = entry;
      // Download fallito: via dalla cache, la prossima chiamata riprova.
      client.catch(() => { if (this.cache === entry) this.cache = null; });
    }
    try {
      return await this.cache!.client;
    } catch (err: any) {
      this.logger.warn(`WSDL ARSS non raggiungibile: ${err?.code ?? err?.message ?? err}`);
      throw new RemoteSignError('network', 'Servizio di firma Aruba non raggiungibile');
    }
  }

  private async identity(creds: ArssCredentials): Promise<Record<string, string>> {
    return {
      user: creds.user,
      userPWD: creds.password,
      typeOtpAuth: await this.setting('remoteSign.otpDomain', 'firma'),
      typeHSM: await this.setting('remoteSign.typeHsm', 'COSIGN'),
    };
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      if (err instanceof RemoteSignError) throw err;
      this.logger.warn(`Chiamata ARSS fallita: ${err?.code ?? err?.message ?? 'errore sconosciuto'}`);
      throw new RemoteSignError('network', 'Servizio di firma Aruba non raggiungibile');
    }
  }

  async openSession(creds: ArssCredentials, otp: string): Promise<string> {
    const client = await this.client();
    const identity = { ...(await this.identity(creds)), otpPwd: otp };
    const [res] = await this.call<any[]>(() => client.opensessionAsync({ Identity: identity }));
    const sessionId: unknown = res?.return;
    if (typeof sessionId !== 'string' || sessionId === '' || sessionId.startsWith('KO') || res?.status === 'KO') {
      this.logger.warn(`opensession ARSS rifiutata: codice=${res?.return_code ?? '?'} descrizione=${res?.description ?? '?'}`);
      throw classifyArssError('open', res?.return_code ?? null, res?.description ?? null);
    }
    return sessionId;
  }

  async signPdf(sessionId: string, creds: ArssCredentials, pdf: Buffer): Promise<Buffer> {
    const client = await this.client();
    const [res] = await this.call<any[]>(async () => client.pdfsignatureV2Async({
      SignRequestV2: {
        binaryinput: pdf.toString('base64'),
        certID: await this.setting('remoteSign.certId', 'AS0'),
        identity: await this.identity(creds),
        requiredmark: false,
        session_id: sessionId,
        transport: 'BYNARYNET',
      },
      pdfprofile: 'PADESBES',
    }));
    const ret = res?.return ?? res;
    if (ret?.status !== 'OK' || !ret?.binaryoutput) {
      this.logger.warn(`pdfsignatureV2 ARSS rifiutata: codice=${ret?.return_code ?? '?'} descrizione=${ret?.description ?? '?'}`);
      throw classifyArssError('sign', ret?.return_code ?? null, ret?.description ?? null);
    }
    return Buffer.from(ret.binaryoutput, 'base64');
  }

  async closeSession(sessionId: string, creds: ArssCredentials): Promise<void> {
    try {
      const client = await this.client();
      await client.closesessionAsync({ Identity: await this.identity(creds), sessionid: sessionId });
    } catch (err: any) {
      this.logger.warn(`closesession ARSS fallita: ${err?.code ?? err?.message ?? 'errore sconosciuto'}`);
    }
  }
}
