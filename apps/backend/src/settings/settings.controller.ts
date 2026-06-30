import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Roles } from '../auth/decorators/roles.decorator';
import * as nodemailer from 'nodemailer';
import type { AppConfiguration } from '../config/configuration';

class TestConnectionDto {
  host!: string;
  port!: number;
  user?: string;
  pass?: string;
  from!: string;
  to!: string;
}

@Controller('settings')
@Roles('admin')
export class SettingsController {
  private readonly logger = new Logger(SettingsController.name);

  constructor(private readonly configService: ConfigService<AppConfiguration, true>) {}

  @Post('test-email')
  @HttpCode(HttpStatus.OK)
  async testEmail(@Body() body: TestConnectionDto) {
    let password = body.pass;
    if (password === '••••••••' || !password) {
      password = this.configService.get('smtp.password', { infer: true }) || '';
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
      password = this.configService.get('pec.password', { infer: true }) || '';
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
}
