import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateRecipientAddressDto {
  @IsString()
  @IsNotEmpty()
  address!: string;

  @IsString()
  @IsNotEmpty()
  municipality!: string;

  @IsString()
  @IsOptional()
  zip?: string;

  @IsString()
  @IsOptional()
  province?: string;

  /** Denominazione paese (dropdown COUNTRIES lato frontend) — "Italia"/vuoto = domestico. */
  @IsString()
  @IsOptional()
  country?: string;
}
