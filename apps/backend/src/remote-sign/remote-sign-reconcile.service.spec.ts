import { describe, expect, it, vi } from 'vitest';
import { RemoteSignReconcileService } from './remote-sign-reconcile.service.js';
import { RemoteSignJobStatus } from '../entities/remote-sign-job.entity.js';

function build(rows: Array<{ id: string }>) {
  const jobRepo = { find: vi.fn().mockResolvedValue(rows), update: vi.fn() };
  const remove = vi.fn();
  const queue = { getJob: vi.fn().mockResolvedValue({ remove }) };
  const svc = new RemoteSignReconcileService(jobRepo as any, queue as any);
  return { svc, jobRepo, queue, remove };
}

describe('RemoteSignReconcileService', () => {
  it('righe attive → FAILED col messaggio e job BullMQ rimosso', async () => {
    const { svc, jobRepo, queue, remove } = build([{ id: 'j1' }, { id: 'j2' }]);
    await svc.onApplicationBootstrap();
    expect(queue.getJob).toHaveBeenCalledWith('j1');
    expect(remove).toHaveBeenCalledTimes(2);
    expect(jobRepo.update).toHaveBeenCalledTimes(2);
    expect(jobRepo.update).toHaveBeenCalledWith({ id: 'j1' }, expect.objectContaining({
      status: RemoteSignJobStatus.FAILED, errorKind: 'session',
      errorMessage: 'Firma interrotta da un riavvio del server: rilancia con un nuovo OTP',
    }));
  });

  it('job.remove lancia → riga comunque FAILED', async () => {
    const { svc, jobRepo, remove } = build([{ id: 'j1' }]);
    remove.mockRejectedValueOnce(new Error('locked'));
    await svc.onApplicationBootstrap();
    expect(jobRepo.update).toHaveBeenCalledWith({ id: 'j1' }, expect.objectContaining({ status: RemoteSignJobStatus.FAILED }));
  });

  it('nessuna riga attiva → nessun update', async () => {
    const { svc, jobRepo } = build([]);
    await svc.onApplicationBootstrap();
    expect(jobRepo.update).not.toHaveBeenCalled();
  });
});
