import { Injectable, Logger } from '@nestjs/common';
import * as soap from 'soap';
import { AppSettingsService } from '../settings/app-settings.service.js';
import { classifyArssError, RemoteSignError } from './arss-errors.js';

export interface ArssCredentials {
  user: string;
  password: string;
}

/**
 * Client SOAP Aruba Remote Sign Service (ARSS). Flusso verificato dal vivo
 * (spike 2026-10-13, docs/claude/remote-sign.md): opensession con OTP →
 * pdfsignatureV2 con session_id (identity senza otpPwd) → closesession.
 * MAI loggare password, OTP, sessionid o binari.
 */
@Injectable()
export class ArubaSignClient {
  private readonly logger = new Logger(ArubaSignClient.name);

  constructor(private readonly settings: AppSettingsService) {}

  private async client(): Promise<any> {
    const wsdlUrl = await this.settings.get<string>('remoteSign.wsdlUrl');
    try {
      return await soap.createClientAsync(wsdlUrl, { endpoint: wsdlUrl.replace(/\?wsdl$/i, '') });
    } catch (err: any) {
      this.logger.warn(`WSDL ARSS non raggiungibile: ${err?.code ?? err?.message ?? err}`);
      throw new RemoteSignError('network', 'Servizio di firma Aruba non raggiungibile');
    }
  }

  private async identity(creds: ArssCredentials): Promise<Record<string, string>> {
    return {
      user: creds.user,
      userPWD: creds.password,
      typeOtpAuth: await this.settings.get<string>('remoteSign.otpDomain'),
      typeHSM: await this.settings.get<string>('remoteSign.typeHsm'),
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
        certID: await this.settings.get<string>('remoteSign.certId'),
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
