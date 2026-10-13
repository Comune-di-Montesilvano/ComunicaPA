// apps/backend/src/legal-attention/legal-attention.controller.ts
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { LegalAttentionService } from './legal-attention.service.js';
import { CreateLegalAttentionReviewDto } from './dto/create-legal-attention-review.dto.js';

type OperatorRequest = Request & { user: JwtOperatorPayload };

const userOf = (req: OperatorRequest) => ({ username: req.user.username, role: req.user.role });

@Controller('admin/legal-attention')
@Roles('user', 'admin')
export class LegalAttentionController {
  constructor(private readonly service: LegalAttentionService) {}

  @Get()
  getSummary(@Query('refresh') refresh: string | undefined, @Req() req: OperatorRequest) {
    return this.service.getSummary(userOf(req), { refresh: refresh === '1' || refresh === 'true' });
  }

  @Get('campaigns/:id')
  getCampaignItems(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @Req() req: OperatorRequest,
  ) {
    return this.service.getCampaignItems(id, userOf(req), Number(page) || 1, Number(pageSize) || 50);
  }

  @Post('reviews')
  @HttpCode(200)
  applyReviews(@Body() dto: CreateLegalAttentionReviewDto, @Req() req: OperatorRequest) {
    return this.service.applyReviews(dto, userOf(req));
  }
}
