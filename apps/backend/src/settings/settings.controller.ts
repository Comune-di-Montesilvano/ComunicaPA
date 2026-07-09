import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { Roles } from '../auth/decorators/roles.decorator';
import type { Request } from 'express';
import * as nodemailer from 'nodemailer';
import { AppSettingsService } from './app-settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { isSettingKey } from './settings.registry';
import { PdndAuthService } from '../channels/send/pdnd-auth.service';

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

  constructor(
    private readonly appSettings: AppSettingsService,
    private readonly pdndAuth: PdndAuthService,
  ) {}

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

  @Post('send/:env/generate-keypair')
  @HttpCode(HttpStatus.OK)
  async generateSendKeypair(@Param('env') env: string, @Req() req: Request) {
    const key = this.sendPrivateKeySetting(env);

    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const user = (req as { user?: { username?: string } }).user?.username ?? 'sconosciuto';
    await this.appSettings.setMany({ [key]: privateKey }, user);

    // La chiave pubblica NON viene persistita: va copiata subito e caricata su PDND.
    return { publicKey };
  }

  @Post('send/:env/test-connection')
  @HttpCode(HttpStatus.OK)
  async testSendConnection(@Param('env') env: string) {
    if (env !== 'test' && env !== 'prod') {
      throw new BadRequestException('Ambiente non valido: usare "test" o "prod"');
    }
    try {
      await this.pdndAuth.getVoucher(env, true);
      return { success: true, message: 'Voucher PDND ottenuto correttamente: credenziali valide.' };
    } catch (error: any) {
      return { success: false, message: error.message || 'Errore sconosciuto durante la richiesta del voucher PDND.' };
    }
  }

  @Get('send/:env/private-key')
  async exportSendPrivateKey(@Param('env') env: string) {
    const key = this.sendPrivateKeySetting(env);
    const privateKey = await this.appSettings.get<string>(key);
    if (!privateKey) {
      throw new BadRequestException(`Nessuna chiave privata salvata per l'ambiente "${env}"`);
    }
    return { privateKey };
  }

  @Get('send/:env/public-key')
  async exportSendPublicKey(@Param('env') env: string) {
    const key = this.sendPrivateKeySetting(env);
    const privateKey = await this.appSettings.get<string>(key);
    if (!privateKey) {
      throw new BadRequestException(`Nessuna chiave privata salvata per l'ambiente "${env}": genera o importa prima una coppia di chiavi.`);
    }
    try {
      const publicKey = createPublicKey(createPrivateKey(privateKey)).export({ type: 'spki', format: 'pem' }) as string;
      return { publicKey };
    } catch (error: any) {
      throw new BadRequestException(`Chiave privata non valida: ${error.message}`);
    }
  }

  private sendPrivateKeySetting(env: string) {
    if (env !== 'test' && env !== 'prod') {
      throw new BadRequestException('Ambiente non valido: usare "test" o "prod"');
    }
    const key = `send.${env}.pdndPrivateKey`;
    if (!isSettingKey(key)) {
      throw new BadRequestException(`Chiave setting non trovata: ${key}`);
    }
    return key;
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
