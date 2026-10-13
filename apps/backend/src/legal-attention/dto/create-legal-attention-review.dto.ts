// apps/backend/src/legal-attention/dto/create-legal-attention-review.dto.ts
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { LegalAttentionAction } from '../legal-attention.util.js';

export class CreateLegalAttentionReviewDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  recipientIds!: string[];

  @IsIn(['ack', 'snooze'])
  action!: LegalAttentionAction;

  @IsOptional()
  @IsISO8601()
  snoozedUntil?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
