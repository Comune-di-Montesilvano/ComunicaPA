import { IsObject } from 'class-validator';

export class UpdateSettingsDto {
  @IsObject()
  settings!: Record<string, string | number | boolean>;
}
