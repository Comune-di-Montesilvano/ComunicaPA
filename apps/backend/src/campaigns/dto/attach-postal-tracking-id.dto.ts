import { IsNotEmpty, IsString } from 'class-validator';

export class AttachPostalTrackingIdDto {
  @IsString()
  @IsNotEmpty()
  idPro!: string;
}
