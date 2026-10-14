import { beforeEach, describe, expect, it, vi } from 'vitest';

const soapClient = {
  opensessionAsync: vi.fn(),
  pdfsignatureV2Async: vi.fn(),
  closesessionAsync: vi.fn(),
};
vi.mock('soap', () => ({ createClientAsync: vi.fn(async () => soapClient) }));

import * as soap from 'soap';
import { ArubaSignClient } from './aruba-sign.client.js';

const settings = {
  get: vi.fn(async (key: string) => ({
    'remoteSign.wsdlUrl': 'https://arss.example/ArubaSignService/ArubaSignService?wsdl',
    'remoteSign.otpDomain': 'firma',
    'remoteSign.typeHsm': 'COSIGN',
    'remoteSign.certId': 'AS0',
  } as Record<string, string>)[key]),
};
const creds = { user: 'mario', password: 'segreta' };

describe('ArubaSignClient', () => {
  let client: ArubaSignClient;
  beforeEach(() => {
    vi.clearAllMocks();
    client = new ArubaSignClient(settings as any);
  });

  it('openSession invia user/password/otp/dominio e restituisce il sessionid', async () => {
    soapClient.opensessionAsync.mockResolvedValueOnce([{ return: 'SESS-1' }]);
    await expect(client.openSession(creds, '123456')).resolves.toBe('SESS-1');
    expect(soap.createClientAsync).toHaveBeenCalledWith(
      'https://arss.example/ArubaSignService/ArubaSignService?wsdl',
      { endpoint: 'https://arss.example/ArubaSignService/ArubaSignService' },
    );
    expect(soapClient.opensessionAsync).toHaveBeenCalledWith({
      Identity: { user: 'mario', userPWD: 'segreta', otpPwd: '123456', typeOtpAuth: 'firma', typeHSM: 'COSIGN' },
    });
  });

  it('openSession con status KO → RemoteSignError credentials', async () => {
    soapClient.opensessionAsync.mockResolvedValueOnce([{ return: 'KO-0001', status: 'KO', return_code: '0001', description: 'OTP not valid' }]);
    await expect(client.openSession(creds, '000000')).rejects.toMatchObject({ kind: 'credentials' });
  });

  it('openSession con errore di rete → network', async () => {
    soapClient.opensessionAsync.mockRejectedValueOnce(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    await expect(client.openSession(creds, '123456')).rejects.toMatchObject({ kind: 'network' });
  });

  it('signPdf usa session_id, PADESBES, nessun otpPwd, e restituisce il binario', async () => {
    soapClient.pdfsignatureV2Async.mockResolvedValueOnce([{ return: { status: 'OK', return_code: '0000', binaryoutput: Buffer.from('FIRMATO').toString('base64') } }]);
    const out = await client.signPdf('SESS-1', creds, Buffer.from('PDF'));
    expect(out.toString()).toBe('FIRMATO');
    const arg = soapClient.pdfsignatureV2Async.mock.calls[0][0];
    expect(arg.pdfprofile).toBe('PADESBES');
    expect(arg.SignRequestV2).toMatchObject({
      certID: 'AS0', requiredmark: false, session_id: 'SESS-1', transport: 'BYNARYNET',
      binaryinput: Buffer.from('PDF').toString('base64'),
      identity: { user: 'mario', userPWD: 'segreta', typeOtpAuth: 'firma', typeHSM: 'COSIGN' },
    });
    expect(arg.SignRequestV2.identity.otpPwd).toBeUndefined();
    expect(arg.Apparence).toBeUndefined();
  });

  it('signPdf con KO su sessione → session', async () => {
    soapClient.pdfsignatureV2Async.mockResolvedValueOnce([{ return: { status: 'KO', return_code: '0001', description: 'Session expired' } }]);
    await expect(client.signPdf('SESS-1', creds, Buffer.from('PDF'))).rejects.toMatchObject({ kind: 'session' });
  });

  it('closeSession non lancia mai', async () => {
    soapClient.closesessionAsync.mockRejectedValueOnce(new Error('boom'));
    await expect(client.closeSession('SESS-1', creds)).resolves.toBeUndefined();
    expect(soapClient.closesessionAsync).toHaveBeenCalledWith({
      Identity: { user: 'mario', userPWD: 'segreta', typeOtpAuth: 'firma', typeHSM: 'COSIGN' },
      sessionid: 'SESS-1',
    });
  });

  it('non logga mai password, OTP o sessionid', async () => {
    const spy = vi.spyOn((client as any).logger, 'warn');
    soapClient.opensessionAsync.mockResolvedValueOnce([{ status: 'KO', return_code: '0001', description: 'bad' }]);
    await client.openSession(creds, '987654').catch(() => undefined);
    const logged = spy.mock.calls.flat().join(' ');
    expect(logged).not.toContain('segreta');
    expect(logged).not.toContain('987654');
  });

  it('impostazioni vuote → default del registry', async () => {
    const empty = new ArubaSignClient({ get: vi.fn(async () => '') } as any);
    soapClient.opensessionAsync.mockResolvedValueOnce([{ return: 'SESS-1' }]);
    soapClient.pdfsignatureV2Async.mockResolvedValueOnce([{ return: { status: 'OK', binaryoutput: Buffer.from('F').toString('base64') } }]);
    await empty.openSession(creds, '123456');
    await empty.signPdf('SESS-1', creds, Buffer.from('PDF'));
    expect(soap.createClientAsync).toHaveBeenCalledWith(
      'https://arss.arubapec.it/ArubaSignService/ArubaSignService?wsdl',
      { endpoint: 'https://arss.arubapec.it/ArubaSignService/ArubaSignService' },
    );
    expect(soapClient.opensessionAsync.mock.calls[0][0].Identity).toMatchObject({ typeOtpAuth: 'firma', typeHSM: 'COSIGN' });
    expect(soapClient.pdfsignatureV2Async.mock.calls[0][0].SignRequestV2.certID).toBe('AS0');
  });

  it('WSDL scaricato una sola volta per lo stesso URL', async () => {
    soapClient.opensessionAsync.mockResolvedValue([{ return: 'SESS-1' }]);
    await client.openSession(creds, '1');
    await client.openSession(creds, '2');
    await client.closeSession('SESS-1', creds);
    expect(soap.createClientAsync).toHaveBeenCalledTimes(1);
    soapClient.opensessionAsync.mockReset();
  });

  it('URL WSDL cambiato → nuovo client', async () => {
    let url = 'https://a.example/x?wsdl';
    const c = new ArubaSignClient({ get: vi.fn(async (k: string) => (k === 'remoteSign.wsdlUrl' ? url : 'v')) } as any);
    await c.closeSession('S', creds);
    url = 'https://b.example/x?wsdl';
    await c.closeSession('S', creds);
    await c.closeSession('S', creds);
    expect(soap.createClientAsync).toHaveBeenCalledTimes(2);
    expect((soap.createClientAsync as any).mock.calls[1][0]).toBe('https://b.example/x?wsdl');
  });

  it('download WSDL fallito → errore network e nuovo tentativo alla chiamata successiva', async () => {
    (soap.createClientAsync as any).mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    await expect(client.openSession(creds, '1')).rejects.toMatchObject({ kind: 'network' });
    soapClient.opensessionAsync.mockResolvedValueOnce([{ return: 'SESS-2' }]);
    await expect(client.openSession(creds, '2')).resolves.toBe('SESS-2');
    expect(soap.createClientAsync).toHaveBeenCalledTimes(2);
  });
});
