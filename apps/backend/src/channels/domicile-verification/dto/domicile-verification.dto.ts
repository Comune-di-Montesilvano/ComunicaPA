import { IsBoolean, IsString, IsUUID, MinLength } from 'class-validator';

export class VerifyDomicileBulkCompleteDto {
  @IsBoolean()
  hasHeaders!: boolean;

  @IsString() @MinLength(1)
  cfColumn!: string;

  @IsUUID()
  ioServiceId!: string;
}
