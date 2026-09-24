import { IsIn, IsOptional, IsString, MinLength, ValidateIf } from 'class-validator';

export class OidcCallbackDto {
  // Assente quando il proxy riporta un errore (es. access_denied dall'IdP).
  @ValidateIf((o: OidcCallbackDto) => !o.error)
  @IsString()
  @MinLength(1)
  code?: string;

  @IsString()
  @MinLength(1)
  state!: string;

  @IsOptional()
  @IsString()
  error?: string;
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

  // Simulatore dev: accesso per conto di un'impresa (solo LDAP_HOST=mock).
  @IsOptional()
  @IsIn(['PF', 'PG'])
  accessType?: 'PF' | 'PG';

  @IsOptional()
  @IsString()
  ivaCode?: string;

  @IsOptional()
  @IsString()
  companyName?: string;

  @IsOptional()
  @IsString()
  registeredOffice?: string;
}
