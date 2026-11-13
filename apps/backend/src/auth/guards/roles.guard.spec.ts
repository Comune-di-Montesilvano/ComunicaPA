import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';

function contextFor(handlerRoles: string[] | undefined, user?: { role: string }): ExecutionContext {
  const handler = () => undefined;
  if (handlerRoles) Reflect.defineMetadata(ROLES_KEY, handlerRoles, handler);
  class Ctrl {}
  return {
    getHandler: () => handler,
    getClass: () => Ctrl,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('ruoli non dichiarati → passa (comportamento attuale)', () => {
    expect(guard.canActivate(contextFor(undefined))).toBe(true);
  });

  it('ruoli vuoti → passa (comportamento attuale)', () => {
    expect(guard.canActivate(contextFor([]))).toBe(true);
  });

  it('utente assente con ruoli richiesti → ForbiddenException', () => {
    expect(() => guard.canActivate(contextFor(['admin']))).toThrow(ForbiddenException);
  });

  it('ruolo non ammesso → ForbiddenException "Ruolo richiesto: admin"', () => {
    expect(() => guard.canActivate(contextFor(['admin'], { role: 'user' }))).toThrow(new ForbiddenException('Ruolo richiesto: admin'));
  });

  it('ruolo ammesso → true', () => {
    expect(guard.canActivate(contextFor(['user', 'admin'], { role: 'user' }))).toBe(true);
  });
});
