import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtOperatorPayload, OperatorRole } from '@comunicapa/shared-types';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<OperatorRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: JwtOperatorPayload }>();
    const user = request.user;

    if (!user) throw new ForbiddenException('Token operatore richiesto');
    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException(`Ruolo richiesto: ${requiredRoles.join(' o ')}`);
    }

    return true;
  }
}
