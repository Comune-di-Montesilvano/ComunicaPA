import { describe, it, expect, vi } from 'vitest';
import { OperatorDirectoryService } from './operator-directory.service.js';

function make(rows: Array<{ username: string; displayName: string }>) {
  const repo = {
    find: vi.fn().mockResolvedValue(rows),
    existsBy: vi.fn(async ({ username }: { username: string }) => rows.some((r) => r.username === username)),
    upsert: vi.fn(),
  };
  return { repo, service: new OperatorDirectoryService(repo as never) };
}

describe('OperatorDirectoryService', () => {
  it('listAll ordina per displayName e restituisce solo username/displayName', async () => {
    const { repo, service } = make([
      { username: 'rossi', displayName: 'Rossi Mario' },
      { username: 'bianchi', displayName: 'Bianchi Anna' },
    ]);
    const res = await service.listAll();
    expect(repo.find).toHaveBeenCalledWith({ select: { username: true, displayName: true }, order: { displayName: 'ASC' } });
    expect(res).toEqual([
      { username: 'rossi', displayName: 'Rossi Mario' },
      { username: 'bianchi', displayName: 'Bianchi Anna' },
    ]);
  });

  it('exists true/false', async () => {
    const { service } = make([{ username: 'rossi', displayName: 'Rossi Mario' }]);
    expect(await service.exists('rossi')).toBe(true);
    expect(await service.exists('ghost')).toBe(false);
  });
});
