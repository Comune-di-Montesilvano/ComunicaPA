import { ExternalNotificationsController } from './external-notifications.controller.js';
import type { ExternalNotificationsService } from './external-notifications.service.js';
import type { ExternalNotificationStatusService } from './external-notification-status.service.js';

// Validazione, idempotenza e stato sono coperti dagli spec dei rispettivi service
// e da external-api-http-status.integration.spec.ts (HTTP reale).
describe('ExternalNotificationsController', () => {
  const req = { apiClient: { id: 'client-1', name: 'Gestionale Tributi' } } as any;
  const notifications = { create: jest.fn().mockResolvedValue({ success: true, notificationId: 'rec-1', status: 'accepted' }) };
  const status = { get: jest.fn().mockResolvedValue({ success: true, notificationId: 'rec-1' }) };
  const controller = new ExternalNotificationsController(
    notifications as unknown as ExternalNotificationsService,
    status as unknown as ExternalNotificationStatusService,
  );

  it('create passa body grezzo, client e Idempotency-Key al service', async () => {
    const body = { channel: 'EMAIL' };
    await expect(controller.create(body, 'k-1', req)).resolves.toEqual({ success: true, notificationId: 'rec-1', status: 'accepted' });
    expect(notifications.create).toHaveBeenCalledWith(body, req.apiClient, 'k-1');
  });

  it('get legge lo stato per notificationId e id del client chiamante', async () => {
    await controller.get('rec-1', req);
    expect(status.get).toHaveBeenCalledWith('rec-1', 'client-1');
  });
});
