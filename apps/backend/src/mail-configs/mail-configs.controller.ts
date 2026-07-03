import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { MailConfigsService } from './mail-configs.service';
import { CreateMailConfigDto, UpdateMailConfigDto } from './dto/mail-config.dto';
import type { MailServerType } from '../entities/mail-server-config.entity';

@Controller('mail-configs')
export class MailConfigsController {
  constructor(private readonly svc: MailConfigsService) {}

  /** Lista mascherata: serve anche agli operatori (wizard: scelta mittente). */
  @Get()
  @Roles('user', 'admin')
  async list(@Query('type') type?: string) {
    if (type && type !== 'EMAIL' && type !== 'PEC') {
      throw new BadRequestException('type deve essere EMAIL o PEC');
    }
    return { configs: await this.svc.listMasked(type as MailServerType | undefined) };
  }

  @Post()
  @Roles('admin')
  create(@Body() dto: CreateMailConfigDto) {
    return this.svc.create(dto);
  }

  @Put(':id')
  @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMailConfigDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(id);
  }

  @Post(':id/test')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  test(@Param('id', ParseUUIDPipe) id: string, @Body() body: { to: string }) {
    return this.svc.test(id, body?.to ?? '');
  }

  @Patch(':id/active')
  @Roles('admin')
  setActive(@Param('id', ParseUUIDPipe) id: string, @Body() body: { active: boolean }) {
    if (typeof body?.active !== 'boolean') {
      throw new BadRequestException('Campo "active" booleano richiesto');
    }
    return this.svc.setActive(id, body.active);
  }
}
