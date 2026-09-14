import { vi } from 'vitest';
import { PostalAuthorizedUsersController } from './postal-authorized-users.controller.js';
import type { PostalAuthorizedUsersService } from './postal-authorized-users.service.js';

describe('PostalAuthorizedUsersController', () => {
  const svc = {
    list: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
  };
  const controller = new PostalAuthorizedUsersController(svc as unknown as PostalAuthorizedUsersService);

  it('list() delega al service', async () => {
    svc.list.mockResolvedValueOnce([{ id: '1', username: 'mario.rossi', addedBy: 'admin1', createdAt: '2026-01-01' }]);
    const result = await controller.list();
    expect(result).toEqual({ users: [{ id: '1', username: 'mario.rossi', addedBy: 'admin1', createdAt: '2026-01-01' }] });
  });

  it('create() passa username e requester.username al service', async () => {
    svc.create.mockResolvedValueOnce({ id: '2', username: 'nuovo', addedBy: 'admin1', createdAt: '2026-01-01' });
    const req = { user: { username: 'admin1', role: 'admin' as const } };
    await controller.create({ username: 'nuovo' }, req as never);
    expect(svc.create).toHaveBeenCalledWith('nuovo', 'admin1');
  });

  it('remove() delega al service', async () => {
    await controller.remove('id-1');
    expect(svc.remove).toHaveBeenCalledWith('id-1');
  });
});
