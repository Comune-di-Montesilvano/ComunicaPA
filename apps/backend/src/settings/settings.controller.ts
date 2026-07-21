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
import { isSettingKey, type SettingKey } from './settings.registry';
import { PdndAuthService } from '../pdnd/pdnd-auth.service';
import { InadService } from '../channels/inad/inad.service';

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
    private readonly inadService: InadService,
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

  @Post('pdnd/:env/generate-keypair')
  @HttpCode(HttpStatus.OK)
  async generatePdndKeypair(@Param('env') env: string, @Req() req: Request) {
    const key = this.pdndPrivateKeySetting(env);

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

  @Post('pdnd/:env/validate-client')
  @HttpCode(HttpStatus.OK)
  async validatePdndClient(@Param('env') env: string) {
    if (env !== 'test' && env !== 'prod') {
      throw new BadRequestException('Ambiente non valido: usare "test" o "prod"');
    }
    // PDND rilascia un voucher solo per la coppia client+finalità: non esiste un
    // endpoint per validare il client da solo. Qui si verifica quindi solo in
    // locale che le credenziali siano compilate e la chiave privata sia
    // effettivamente una chiave RSA valida — nessuna chiamata a PDND. Il test
    // reale del voucher va fatto dal tab del servizio (SEND/INAD/INIPEC) con
    // il relativo Purpose ID.
    const prefix = `pdnd.${env}`;
    const [tokenUrl, audience, clientId, kid, privateKey] = await Promise.all([
      this.appSettings.get<string>(`${prefix}.tokenUrl` as SettingKey),
      this.appSettings.get<string>(`${prefix}.audience` as SettingKey),
      this.appSettings.get<string>(`${prefix}.clientId` as SettingKey),
      this.appSettings.get<string>(`${prefix}.kid` as SettingKey),
      this.appSettings.get<string>(`${prefix}.privateKey` as SettingKey),
    ]);
    const missing = Object.entries({ tokenUrl, audience, clientId, kid, privateKey })
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      return { success: false, message: `Configurazione PDND (${env}) incompleta: mancano ${missing.join(', ')}` };
    }
    try {
      createPrivateKey(privateKey);
    } catch (error: any) {
      return { success: false, message: `Chiave privata non valida: ${error.message}` };
    }
    return { success: true, message: 'Configurazione locale valida: campi compilati e chiave privata corretta. Per verificare il voucher reale usa "Test connessione" nel tab del servizio (SEND/INAD/INIPEC).' };
  }

  @Post('send/:env/test-connection')
  @HttpCode(HttpStatus.OK)
  async testSendConnection(@Param('env') env: string) {
    // PN richiede ENTRAMBI gli header su ogni chiamata: x-api-key (portale
    // self-care PN) e Authorization: Bearer <voucher PDND> — confermato dalla
    // documentazione ufficiale developer.pagopa.it (esempio curl verbatim).
    // Test dedicato: chiamata reale GET senza side-effect (nessun
    // invio/protocollo), solo per validare API Key + voucher.
    if (env !== 'test' && env !== 'prod') {
      throw new BadRequestException('Ambiente non valido: usare "test" o "prod"');
    }
    const baseUrl = await this.appSettings.get<string>(`send.${env}.baseUrl` as SettingKey);
    const apiKey = await this.appSettings.get<string>(`send.${env}.apiKey` as SettingKey);
    if (!apiKey) {
      return { success: false, message: `API Key SEND (${env}) non configurata.` };
    }
    const purposeId = await this.appSettings.get<string>(`send.${env}.purposeId` as SettingKey);
    if (!purposeId) {
      return { success: false, message: `Purpose ID SEND (${env}) non configurato (necessario per ottenere il voucher PDND).` };
    }
    let voucher: string;
    try {
      voucher = await this.pdndAuth.getVoucher(env, purposeId, true);
    } catch (error: any) {
      return { success: false, message: error.message || 'Errore sconosciuto durante la richiesta del voucher PDND.' };
    }
    try {
      // Query param si chiama notificationRequestId, NON requestId (schema
      // GET /delivery/v2.6/requests) — vedi send-status-sync.service.ts.
      const res = await fetch(`${baseUrl}/delivery/v2.6/requests?notificationRequestId=comunicapa-test-connection`, {
        headers: { 'x-api-key': apiKey, Authorization: `Bearer ${voucher}` },
      });
      if (res.status === 401 || res.status === 403) {
        return { success: false, message: `API Key/voucher SEND (${env}) rifiutati da PN: HTTP ${res.status}.` };
      }
      // 400/404 sono attesi (requestId inventato non esiste): confermano solo
      // che l'autenticazione è passata, non che la richiesta abbia senso.
      return { success: true, message: `API Key + voucher PDND SEND (${env}) accettati da PN (HTTP ${res.status}).` };
    } catch (error: any) {
      return { success: false, message: error.message || 'Errore sconosciuto durante la verifica della connessione SEND.' };
    }
  }

  @Get('send/:env/groups')
  @HttpCode(HttpStatus.OK)
  async getSendGroups(@Param('env') env: string): Promise<{ groups: Array<{ id: string; name: string; description: string; status: string }>; error?: string }> {
    // /ext-registry-b2b/pa/v1/groups (repo pn-external-registries) richiede
    // SOLO x-api-key — a differenza di /delivery/*, questo endpoint NON
    // richiede il voucher PDND (securitySchemes: solo ApiKeyAuth). Sempre
    // HTTP 200 anche in errore: il reverse proxy esterno in produzione
    // sostituisce il body delle risposte non-2xx (vedi CLAUDE.md).
    if (env !== 'test' && env !== 'prod') {
      throw new BadRequestException('Ambiente non valido: usare "test" o "prod"');
    }
    const baseUrl = await this.appSettings.get<string>(`send.${env}.baseUrl` as SettingKey);
    const apiKey = await this.appSettings.get<string>(`send.${env}.apiKey` as SettingKey);
    if (!apiKey) {
      return { groups: [], error: `API Key SEND (${env}) non configurata.` };
    }
    try {
      const res = await fetch(`${baseUrl}/ext-registry-b2b/pa/v1/groups?statusFilter=ACTIVE`, {
        headers: { 'x-api-key': apiKey },
      });
      if (!res.ok) {
        return { groups: [], error: `PN ha rifiutato la richiesta gruppi: HTTP ${res.status}.` };
      }
      const data = (await res.json()) as Array<{ id: string; name: string; description: string; status: string }>;
      return { groups: data.filter((g) => g.status === 'ACTIVE') };
    } catch (error: any) {
      return { groups: [], error: error.message || 'Errore sconosciuto durante il recupero dei gruppi PN.' };
    }
  }

  @Post('inad/:env/test-connection')
  @HttpCode(HttpStatus.OK)
  async testInadConnection(@Param('env') env: string) {
    return this.testServicePurposeConnection(env, 'inad');
  }

  @Post('inad/prod/extract')
  @HttpCode(HttpStatus.OK)
  async extractInadDigitalAddress(@Body() body: { codiceFiscale?: string }) {
    if (!body.codiceFiscale) {
      throw new BadRequestException('codiceFiscale obbligatorio');
    }
    try {
      const result = await this.inadService.extractDigitalAddress(body.codiceFiscale);
      return { success: true, found: result.found, data: result.data };
    } catch (error: any) {
      return { success: false, message: error.message || 'Errore sconosciuto durante l\'interrogazione INAD.' };
    }
  }

  @Post('inipec/:env/test-connection')
  @HttpCode(HttpStatus.OK)
  async testInipecConnection(@Param('env') env: string) {
    return this.testServicePurposeConnection(env, 'inipec');
  }

  @Post('anpr/:env/test-connection')
  @HttpCode(HttpStatus.OK)
  async testAnprConnection(@Param('env') env: string) {
    return this.testServicePurposeConnection(env, 'anpr');
  }

  private async testServicePurposeConnection(env: string, service: 'send' | 'inad' | 'inipec' | 'anpr') {
    if (env !== 'test' && env !== 'prod') {
      throw new BadRequestException('Ambiente non valido: usare "test" o "prod"');
    }
    const purposeId = await this.appSettings.get<string>(`${service}.${env}.purposeId` as SettingKey);
    if (!purposeId) {
      return { success: false, message: `Purpose ID ${service.toUpperCase()} (${env}) non configurato.` };
    }
    try {
      await this.pdndAuth.getVoucher(env, purposeId, true);
      return { success: true, message: 'Voucher PDND ottenuto correttamente: client e finalità validi.' };
    } catch (error: any) {
      return { success: false, message: error.message || 'Errore sconosciuto durante la richiesta del voucher PDND.' };
    }
  }

  @Get('pdnd/:env/private-key')
  async exportPdndPrivateKey(@Param('env') env: string) {
    const key = this.pdndPrivateKeySetting(env);
    const privateKey = await this.appSettings.get<string>(key);
    if (!privateKey) {
      throw new BadRequestException(`Nessuna chiave privata salvata per l'ambiente "${env}"`);
    }
    return { privateKey };
  }

  @Get('pdnd/:env/public-key')
  async exportPdndPublicKey(@Param('env') env: string) {
    const key = this.pdndPrivateKeySetting(env);
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

  private pdndPrivateKeySetting(env: string) {
    if (env !== 'test' && env !== 'prod') {
      throw new BadRequestException('Ambiente non valido: usare "test" o "prod"');
    }
    const key = `pdnd.${env}.privateKey`;
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
