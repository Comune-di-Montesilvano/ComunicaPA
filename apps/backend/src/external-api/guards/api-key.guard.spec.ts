import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { ExternalApiClientsService } from '../external-api-clients.service';

function makeContext(headers: Record<string, string>): ExecutionContext {
  const req: any = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
  let clientsService: { findActiveByKey: jest.Mock; touchLastUsed: jest.Mock };
  let guard: ApiKeyGuard;

  beforeEach(() => {
    clientsService = { findActiveByKey: jest.fn(), touchLastUsed: jest.fn().mockResolvedValue(undefined) };
    guard = new ApiKeyGuard(clientsService as unknown as ExternalApiClientsService);
  });

  it('lancia UnauthorizedException se header X-Api-Key assente', async () => {
    await expect(guard.canActivate(makeContext({}))).rejects.toThrow(UnauthorizedException);
  });

  it('lancia UnauthorizedException se la key non corrisponde a nessun client attivo', async () => {
    clientsService.findActiveByKey.mockResolvedValue(null);
    await expect(guard.canActivate(makeContext({ 'x-api-key': 'key-invalida' }))).rejects.toThrow(UnauthorizedException);
  });

  it('attacca req.apiClient e ritorna true su key valida', async () => {
    const client = { id: 'client-1', name: 'Comune X' };
    clientsService.findActiveByKey.mockResolvedValue(client);
    const ctx = makeContext({ 'x-api-key': 'key-valida' });
    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect((ctx.switchToHttp().getRequest() as any).apiClient).toBe(client);
    expect(clientsService.touchLastUsed).toHaveBeenCalledWith('client-1');
  });
});
