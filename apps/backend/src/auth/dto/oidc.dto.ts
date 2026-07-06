import { IsOptional, IsString, MinLength } from 'class-validator';

export class OidcCallbackDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsString()
  @MinLength(1)
  state!: string;
}

export class CitizenLoginDto {
  @IsString()
  @MinLength(1)
  codiceFiscale!: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  email?: string;
}
