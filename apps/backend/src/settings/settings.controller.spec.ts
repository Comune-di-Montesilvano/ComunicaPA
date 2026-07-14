import { SettingsController } from './settings.controller';
import { MASKED_VALUE } from './settings.registry';

describe('SettingsController — GET/PUT', () => {
  const settingsMock = {
    getAllMasked: jest.fn(async () => ({ 'smtp.host': 'h', 'smtp.password': MASKED_VALUE })),
    setMany: jest.fn(async () => undefined),
    get: jest.fn(async () => ''),
  };

  const pdndAuthMock = { getVoucher: jest.fn(async () => 'voucher') };

  const controller = new SettingsController(settingsMock as never, pdndAuthMock as never);

  it('GET restituisce i settings mascherati', async () => {
    const res = await controller.getAll();
    expect(res).toEqual({ settings: { 'smtp.host': 'h', 'smtp.password': MASKED_VALUE } });
  });

  it('PUT salva con lo username del token e restituisce lo stato aggiornato', async () => {
    const req = { user: { username: 'mario.rossi' } };
    const res = await controller.update({ settings: { 'smtp.host': 'nuovo' } }, req as never);
    expect(settingsMock.setMany).toHaveBeenCalledWith({ 'smtp.host': 'nuovo' }, 'mario.rossi');
    expect(res.settings['smtp.host']).toBe('h');
  });
});

describe('SettingsController — SEND test-connection (x-api-key + voucher PDND)', () => {
  const mockFetch = jest.fn();
  global.fetch = mockFetch as unknown as typeof fetch;

  const values: Record<string, unknown> = {
    'send.test.baseUrl': 'https://send.test',
    'send.test.apiKey': '',
    'send.test.purposeId': '',
  };
  const settingsMock = { get: jest.fn(async (key: string) => values[key]) };
  const pdndAuthMock = { getVoucher: jest.fn(async () => 'voucher-abc') };
  const controller = new SettingsController(settingsMock as never, pdndAuthMock as never);

  beforeEach(() => {
    mockFetch.mockClear();
    pdndAuthMock.getVoucher.mockClear();
  });

  it('fallisce senza chiamare PN se apiKey non è configurata', async () => {
    values['send.test.apiKey'] = '';
    values['send.test.purposeId'] = 'purpose-test';
    const res = await controller.testSendConnection('test');
    expect(res.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(pdndAuthMock.getVoucher).not.toHaveBeenCalled();
  });

  it('fallisce senza chiamare PN se purposeId non è configurato', async () => {
    values['send.test.apiKey'] = 'apikey-real';
    values['send.test.purposeId'] = '';
    const res = await controller.testSendConnection('test');
    expect(res.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(pdndAuthMock.getVoucher).not.toHaveBeenCalled();
  });

  it('invia ENTRAMBI x-api-key e Authorization:Bearer <voucher PDND>', async () => {
    values['send.test.apiKey'] = 'apikey-real';
    values['send.test.purposeId'] = 'purpose-test';
    mockFetch.mockResolvedValueOnce({ status: 400 });

    const res = await controller.testSendConnection('test');

    expect(pdndAuthMock.getVoucher).toHaveBeenCalledWith('test', 'purpose-test', true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery/v2.6/requests?notificationRequestId=comunicapa-test-connection',
      { headers: { 'x-api-key': 'apikey-real', Authorization: 'Bearer voucher-abc' } },
    );
    expect(res.success).toBe(true);
  });

  it('segnala fallimento su 401/403 (api key/voucher rifiutati)', async () => {
    values['send.test.apiKey'] = 'apikey-invalid';
    values['send.test.purposeId'] = 'purpose-test';
    mockFetch.mockResolvedValueOnce({ status: 401 });

    const res = await controller.testSendConnection('test');

    expect(res.success).toBe(false);
  });

  it('segnala fallimento se PdndAuthService non riesce a ottenere il voucher', async () => {
    values['send.test.apiKey'] = 'apikey-real';
    values['send.test.purposeId'] = 'purpose-test';
    pdndAuthMock.getVoucher.mockRejectedValueOnce(new Error('015-0008'));

    const res = await controller.testSendConnection('test');

    expect(res.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
