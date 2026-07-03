import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { IoServicesService } from './io-services.service';
import { CreateIoServiceDto, UpdateIoServiceDto } from './dto/io-service.dto';

@Controller('io-services')
export class IoServicesController {
  constructor(private readonly svc: IoServicesService) {}

  @Get()
  @Roles('user', 'admin')
  list() {
    return this.svc.listMasked().then((configs) => ({ configs }));
  }

  @Post()
  @Roles('admin')
  create(@Body() dto: CreateIoServiceDto) {
    return this.svc.create(dto);
  }

  @Put(':id')
  @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateIoServiceDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(id);
  }

  @Patch(':id/default')
  @Roles('admin')
  setDefault(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.setDefault(id);
  }

  @Post(':id/test')
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  test(@Param('id', ParseUUIDPipe) id: string, @Body() body: { codiceFiscale: string }) {
    return this.svc.test(id, body?.codiceFiscale ?? '');
  }
}
