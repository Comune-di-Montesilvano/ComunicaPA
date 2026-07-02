import { SettingsController } from './settings.controller';
import { MASKED_VALUE } from './settings.registry';

describe('SettingsController — GET/PUT', () => {
  const settingsMock = {
    getAllMasked: jest.fn(async () => ({ 'smtp.host': 'h', 'smtp.password': MASKED_VALUE })),
    setMany: jest.fn(async () => undefined),
    get: jest.fn(async () => ''),
  };

  const controller = new SettingsController(settingsMock as never);

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
