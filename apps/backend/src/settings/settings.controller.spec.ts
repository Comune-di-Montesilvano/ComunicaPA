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

describe('SettingsController — SEND test-connection (x-api-key, no PDND)', () => {
  const mockFetch = jest.fn();
  global.fetch = mockFetch as unknown as typeof fetch;

  const values: Record<string, unknown> = {
    'send.test.baseUrl': 'https://send.test',
    'send.test.apiKey': '',
  };
  const settingsMock = { get: jest.fn(async (key: string) => values[key]) };
  const pdndAuthMock = { getVoucher: jest.fn() };
  const controller = new SettingsController(settingsMock as never, pdndAuthMock as never);

  beforeEach(() => {
    mockFetch.mockClear();
    pdndAuthMock.getVoucher.mockClear();
  });

  it('fallisce senza chiamare PN se apiKey non è configurata', async () => {
    values['send.test.apiKey'] = '';
    const res = await controller.testSendConnection('test');
    expect(res.success).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(pdndAuthMock.getVoucher).not.toHaveBeenCalled();
  });

  it('usa x-api-key (non Authorization/Bearer) e non chiama mai PdndAuthService', async () => {
    values['send.test.apiKey'] = 'apikey-real';
    mockFetch.mockResolvedValueOnce({ status: 400 });

    const res = await controller.testSendConnection('test');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://send.test/delivery/v2.6/requests?requestId=comunicapa-test-connection',
      { headers: { 'x-api-key': 'apikey-real' } },
    );
    expect(pdndAuthMock.getVoucher).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
  });

  it('segnala fallimento su 401/403 (api key rifiutata)', async () => {
    values['send.test.apiKey'] = 'apikey-invalid';
    mockFetch.mockResolvedValueOnce({ status: 401 });

    const res = await controller.testSendConnection('test');

    expect(res.success).toBe(false);
  });
});
