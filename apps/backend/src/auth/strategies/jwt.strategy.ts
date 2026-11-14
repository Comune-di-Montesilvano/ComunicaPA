import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { JwtOperatorPayload, OperatorRole } from '@comunicapa/shared-types';
import type { AppConfiguration } from '../../config/configuration.js';

const OPERATOR_ROLES: readonly OperatorRole[] = ['admin', 'user'];

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService<AppConfiguration, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('jwt.secret', { infer: true }),
    });
  }

  /** Solo token operatore emessi da `AuthService` (type 'operator', ruolo noto). */
  validate(payload: JwtOperatorPayload): JwtOperatorPayload {
    if (payload?.type !== 'operator' || !OPERATOR_ROLES.includes(payload.role)) {
      throw new UnauthorizedException();
    }
    return payload;
  }
}
