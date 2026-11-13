import { vi, type MockInstance } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';

function contextFor(publicOn: 'handler' | 'class' | 'none'): ExecutionContext {
  const handler = () => undefined;
  class Ctrl {}
  if (publicOn === 'handler') Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
  if (publicOn === 'class') Reflect.defineMetadata(IS_PUBLIC_KEY, true, Ctrl);
  return { getHandler: () => handler, getClass: () => Ctrl } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  // super.canActivate = AuthGuard('jwt') di passport (prototipo del mixin).
  const passportProto = Object.getPrototypeOf(JwtAuthGuard.prototype) as { canActivate: (ctx: ExecutionContext) => unknown };
  let superCanActivate: MockInstance;
  const guard = new JwtAuthGuard(new Reflector());

  beforeEach(() => {
    superCanActivate = vi.spyOn(passportProto, 'canActivate').mockReturnValue('passport' as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['handler', 'class'] as const)('@Public su %s → true senza passport', (where) => {
    expect(guard.canActivate(contextFor(where))).toBe(true);
    expect(superCanActivate).not.toHaveBeenCalled();
  });

  it('senza @Public → delega a passport (super.canActivate)', () => {
    const ctx = contextFor('none');
    expect(guard.canActivate(ctx)).toBe('passport');
    expect(superCanActivate).toHaveBeenCalledWith(ctx);
  });
});
