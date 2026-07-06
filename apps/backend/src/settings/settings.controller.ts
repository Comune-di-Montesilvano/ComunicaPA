import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import type { Request } from 'express';
import * as nodemailer from 'nodemailer';
import { AppSettingsService } from './app-settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';

class TestConnectionDto {
  host!: string;
  port!: number;
  user?: string;
  pass?: string;
  from!: string;
  to!: string;
}

@Controller('admin/settings')
@Roles('admin')
export class SettingsController {
  private readonly logger = new Logger(SettingsController.name);

  constructor(private readonly appSettings: AppSettingsService) {}

  @Post('test-email')
  @HttpCode(HttpStatus.OK)
  async testEmail(@Body() body: TestConnectionDto) {
    let password = body.pass;
    if (password === '••••••••' || !password) {
      password = (await this.appSettings.get<string>('smtp.password')) || '';
    }

    try {
      const transporter = nodemailer.createTransport({
        host: body.host,
        port: body.port,
        secure: body.port === 465,
        auth: body.user ? {
          user: body.user,
          pass: password,
        } : undefined,
        tls: {
          rejectUnauthorized: false,
        },
      });

      await transporter.sendMail({
        from: body.from,
        to: body.to,
        subject: 'ComunicaPA - Test Connessione E-mail',
        text: 'Questa è un\'e-mail di test inviata da ComunicaPA per verificare la configurazione del server SMTP.',
        html: '<p>Questa è un\'e-mail di test inviata da <strong>ComunicaPA</strong> per verificare la configurazione del server SMTP.</p>',
      });

      return { success: true, message: 'Email inviata con successo' };
    } catch (error: any) {
      this.logger.error(`SMTP Test failed: ${error.message}`, error.stack);
      throw new BadRequestException(`Errore connessione SMTP: ${error.message}`);
    }
  }

  @Post('test-pec')
  @HttpCode(HttpStatus.OK)
  async testPec(@Body() body: TestConnectionDto) {
    let password = body.pass;
    if (password === '••••••••' || !password) {
      password = (await this.appSettings.get<string>('pec.password')) || '';
    }

    try {
      const transporter = nodemailer.createTransport({
        host: body.host,
        port: body.port,
        secure: body.port === 465,
        auth: body.user ? {
          user: body.user,
          pass: password,
        } : undefined,
        tls: {
          rejectUnauthorized: false,
        },
      });

      await transporter.sendMail({
        from: body.from,
        to: body.to,
        subject: 'ComunicaPA - Test Connessione PEC',
        text: 'Questa è un\'e-mail di test inviata da ComunicaPA per verificare la configurazione del server PEC.',
        html: '<p>Questa è un\'e-mail di test inviata da <strong>ComunicaPA</strong> per verificare la configurazione del server PEC.</p>',
      });

      return { success: true, message: 'PEC inviata con successo' };
    } catch (error: any) {
      this.logger.error(`PEC Test failed: ${error.message}`, error.stack);
      throw new BadRequestException(`Errore connessione PEC: ${error.message}`);
    }
  }

  @Get()
  async getAll() {
    return { settings: await this.appSettings.getAllMasked() };
  }

  @Put()
  async update(@Body() body: UpdateSettingsDto, @Req() req: Request) {
    const user = (req as { user?: { username?: string } }).user?.username ?? 'sconosciuto';
    await this.appSettings.setMany(body.settings, user);
    return { settings: await this.appSettings.getAllMasked() };
  }
}
