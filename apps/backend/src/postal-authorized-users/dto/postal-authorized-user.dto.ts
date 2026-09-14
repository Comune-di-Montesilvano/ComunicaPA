import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreatePostalAuthorizedUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  username!: string;
}

export interface PostalAuthorizedUserDto {
  id: string;
  username: string;
  addedBy: string;
  addedByDisplayName?: string;
  createdAt: string;
}
