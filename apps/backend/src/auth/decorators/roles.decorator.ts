import { SetMetadata } from '@nestjs/common';
import type { OperatorRole } from '@comunicapa/shared-types';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: OperatorRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
