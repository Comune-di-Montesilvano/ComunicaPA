import { vi } from 'vitest';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { OidcAuthGuard } from './oidc-auth.guard.js';

describe('OidcAuthGuard.handleRequest', () => {
  const guard = new OidcAuthGuard();

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('err → rilancia lo stesso err', () => {
    const err = new Error('firma non valida');
    expect(() => guard.handleRequest(err, { sub: 'x' }, undefined)).toThrow(err);
  });

  it('user assente → UnauthorizedException (401)', () => {
    expect(() => guard.handleRequest(null, false, new Error('jwt expired'))).toThrow(UnauthorizedException);
  });

  it('ok → ritorna user', () => {
    const user = { fiscalCode: 'RSSMRA80A01H501U' };
    expect(guard.handleRequest(null, user, undefined)).toBe(user);
  });
});
