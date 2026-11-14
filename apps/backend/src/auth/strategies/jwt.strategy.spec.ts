import { describe, expect, it } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import type { AppConfiguration } from '../../config/configuration.js';
import { JwtStrategy } from './jwt.strategy.js';

const config = { get: () => 'test-secret' } as unknown as ConfigService<AppConfiguration, true>;
const strategy = new JwtStrategy(config);

const operator: JwtOperatorPayload = { sub: 'u1', username: 'mario', role: 'user', type: 'operator' };

describe('JwtStrategy.validate', () => {
  it('accetta un token operatore (user e admin)', () => {
    expect(strategy.validate(operator)).toEqual(operator);
    expect(strategy.validate({ ...operator, role: 'admin' })).toEqual({ ...operator, role: 'admin' });
  });

  it('rifiuta un token senza type operatore', () => {
    const { type: _type, ...noType } = operator;
    expect(() => strategy.validate(noType as unknown as JwtOperatorPayload)).toThrow(UnauthorizedException);
    expect(() => strategy.validate({ ...operator, type: 'citizen' } as unknown as JwtOperatorPayload)).toThrow(
      UnauthorizedException,
    );
  });

  it('rifiuta un ruolo operatore sconosciuto', () => {
    expect(() => strategy.validate({ ...operator, role: 'root' } as unknown as JwtOperatorPayload)).toThrow(
      UnauthorizedException,
    );
  });
});
