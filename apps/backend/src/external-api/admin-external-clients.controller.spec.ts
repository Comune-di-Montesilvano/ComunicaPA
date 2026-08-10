import { AdminExternalClientsController } from './admin-external-clients.controller';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ExternalApiClientsService } from './external-api-clients.service';

describe('AdminExternalClientsController', () => {
  let controller: AdminExternalClientsController;
  let service: { listMasked: jest.Mock; generateKey: jest.Mock; regenerateKey: jest.Mock; revoke: jest.Mock };
  let audit: { log: jest.Mock };

  beforeEach(() => {
    service = {
      listMasked: jest.fn().mockResolvedValue([]),
      generateKey: jest.fn().mockResolvedValue({ client: { id: 'c1' }, apiKeyPlain: 'plain-key' }),
      regenerateKey: jest.fn().mockResolvedValue({ client: { id: 'c1' }, apiKeyPlain: 'new-plain-key' }),
      revoke: jest.fn().mockResolvedValue(undefined),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    controller = new AdminExternalClientsController(
      service as unknown as ExternalApiClientsService,
      audit as unknown as AuditLogsService,
    );
  });

  const req = { user: { username: 'admin1' } } as any;

  it('create ritorna client + apiKeyPlain e logga', async () => {
    const result = await controller.create({ name: 'Comune X' }, req);
    expect(result).toEqual({ client: { id: 'c1' }, apiKeyPlain: 'plain-key' });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'EXTERNAL_CLIENT_CREATE', operator: 'admin1' }));
  });

  it('regenerateKey logga con action dedicata', async () => {
    await controller.regenerateKey('c1', req);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'EXTERNAL_CLIENT_REGENERATE_KEY' }));
  });

  it('revoke logga con action dedicata', async () => {
    await controller.revoke('c1', req);
    expect(service.revoke).toHaveBeenCalledWith('c1');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'EXTERNAL_CLIENT_REVOKE' }));
  });
});
