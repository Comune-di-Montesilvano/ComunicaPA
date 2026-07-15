import {
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
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { PostalProvidersService } from './postal-providers.service';
import { CreatePostalProviderDto, SetActivePostalProviderDto, UpdatePostalProviderDto } from './dto/postal-provider.dto';

@Controller('admin/postal-providers')
export class PostalProvidersController {
  constructor(private readonly svc: PostalProvidersService) {}

  /** Lista mascherata: serve anche agli operatori (wizard: tipologie/contratti disponibili). */
  @Get()
  @Roles('user', 'admin')
  async list() {
    return { providers: await this.svc.listMasked() };
  }

  @Post()
  @Roles('admin')
  create(@Body() dto: CreatePostalProviderDto) {
    return this.svc.create(dto);
  }

  @Put(':id')
  @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePostalProviderDto) {
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
  test(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.test(id);
  }

  @Patch(':id/active')
  @Roles('admin')
  setActive(@Param('id', ParseUUIDPipe) id: string, @Body() body: SetActivePostalProviderDto) {
    return this.svc.setActive(id, body.active);
  }
}
