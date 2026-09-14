import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtOperatorPayload } from '@comunicapa/shared-types';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PostalAuthorizedUsersService } from './postal-authorized-users.service.js';
import { CreatePostalAuthorizedUserDto } from './dto/postal-authorized-user.dto.js';

@Controller('admin/postal-authorized-users')
@Roles('admin')
export class PostalAuthorizedUsersController {
  constructor(private readonly svc: PostalAuthorizedUsersService) {}

  @Get()
  async list() {
    return { users: await this.svc.list() };
  }

  @Post()
  create(
    @Body() dto: CreatePostalAuthorizedUserDto,
    @Req() req: Request & { user: JwtOperatorPayload },
  ) {
    return this.svc.create(dto.username, req.user.username);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(id);
  }
}
