import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { IoServicesService } from './io-services.service';
import { AppIoVerifyBulkService } from './app-io-verify-bulk.service';
import { CreateIoServiceDto, UpdateIoServiceDto, TestIoServiceDto, VerifyBulkDto } from './dto/io-service.dto';

@Controller('admin/io-services')
export class IoServicesController {
  constructor(
    private readonly svc: IoServicesService,
    private readonly bulkSvc: AppIoVerifyBulkService,
  ) {}

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
  test(@Param('id', ParseUUIDPipe) id: string, @Body() body: TestIoServiceDto) {
    return this.svc.test(id, body.codiceFiscale);
  }

  @Post('verify-profile')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  verifyProfile(@Body() body: { codiceFiscale: string }) {
    return this.svc.verifyProfile(body.codiceFiscale);
  }

  @Post('verify-bulk')
  @Roles('user', 'admin')
  @HttpCode(HttpStatus.OK)
  createVerifyBulk(@Body() body: VerifyBulkDto) {
    return this.bulkSvc.createJob(body);
  }

  @Get('verify-bulk/:id')
  @Roles('user', 'admin')
  getVerifyBulkStatus(@Param('id', ParseUUIDPipe) id: string) {
    return this.bulkSvc.getStatus(id);
  }

  @Get('verify-bulk/:id/present.csv')
  @Roles('user', 'admin')
  async downloadVerifyBulkPresent(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const content = await this.bulkSvc.getResultCsv(id, 'present');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="verifica_appio_presenti_${id.slice(0, 8)}.csv"`);
    res.send(content);
  }

  @Get('verify-bulk/:id/absent.csv')
  @Roles('user', 'admin')
  async downloadVerifyBulkAbsent(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const content = await this.bulkSvc.getResultCsv(id, 'absent');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="verifica_appio_assenti_${id.slice(0, 8)}.csv"`);
    res.send(content);
  }
}
