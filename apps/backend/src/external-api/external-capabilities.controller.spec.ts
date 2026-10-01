import { ExternalCapabilitiesController } from './external-capabilities.controller.js';
import type { ExternalCapabilitiesService } from './external-capabilities.service.js';

// La logica (fonti, default, valori ammessi) è coperta da external-capabilities.service.spec.ts.
describe('ExternalCapabilitiesController', () => {
  it('restituisce le capabilities calcolate dal service', async () => {
    const caps = { success: true, channels: {} };
    const service = { getCapabilities: jest.fn().mockResolvedValue(caps) };
    const controller = new ExternalCapabilitiesController(service as unknown as ExternalCapabilitiesService);
    await expect(controller.get()).resolves.toBe(caps);
  });
});
