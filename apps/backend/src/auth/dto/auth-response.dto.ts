import type { OperatorRole } from '@comunicapa/shared-types';

export class AuthResponseDto {
  access_token!: string;
  token_type!: 'Bearer';
  expires_in!: number;
  username!: string;
  role!: OperatorRole;
}
