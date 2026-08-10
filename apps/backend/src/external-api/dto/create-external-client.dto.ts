import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateExternalClientDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;
}
