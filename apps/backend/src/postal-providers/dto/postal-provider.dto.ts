import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { PostalProviderType } from '../../entities/postal-provider-config.entity';

export class CreatePostalProviderDto {
  @IsIn(['GLOBALCOM'])
  type!: PostalProviderType;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  baseUrl!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  username!: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  group?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  centroDiCosto?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  mittenteDenominazione1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  mittenteIndirizzo1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  mittenteCap?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  mittenteCitta?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  mittenteProvincia?: string;
}

// Update: stessi campi ma tutti opzionali tranne type che NON è modificabile
export class UpdatePostalProviderDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(128)
  name?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(255)
  baseUrl?: string;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(255)
  username?: string;

  @IsOptional() @IsString()
  password?: string;

  @IsOptional() @IsString() @MaxLength(128)
  group?: string;

  @IsOptional() @IsString() @MaxLength(128)
  centroDiCosto?: string;

  @IsOptional() @IsString() @MaxLength(128)
  mittenteDenominazione1?: string;

  @IsOptional() @IsString() @MaxLength(128)
  mittenteIndirizzo1?: string;

  @IsOptional() @IsString() @MaxLength(10)
  mittenteCap?: string;

  @IsOptional() @IsString() @MaxLength(128)
  mittenteCitta?: string;

  @IsOptional() @IsString() @MaxLength(2)
  mittenteProvincia?: string;
}

export interface PostalProviderContrattoDto {
  codiceContratto: string;
  descrizione: string;
  tipologia: string;
}

export interface PostalProviderMaskedDto {
  id: string;
  type: PostalProviderType;
  name: string;
  baseUrl: string;
  username: string;
  password: string; // MASKED_VALUE se impostata, '' altrimenti
  group: string;
  centroDiCosto: string;
  mittenteDenominazione1: string;
  mittenteIndirizzo1: string;
  mittenteCap: string;
  mittenteCitta: string;
  mittenteProvincia: string;
  enabledServiceTypes: string[];
  contratti: PostalProviderContrattoDto[];
  testedAt: string | null;
  active: boolean;
}

export class SetActivePostalProviderDto {
  @IsBoolean()
  active!: boolean;
}
