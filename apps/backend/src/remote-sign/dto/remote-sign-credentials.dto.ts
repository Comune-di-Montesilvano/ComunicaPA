import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class RemoteSignCredentialsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  user!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  password!: string;

  @IsString()
  @Matches(/^\d{6,8}$/, { message: "L'OTP deve essere di 6-8 cifre" })
  otp!: string;
}
