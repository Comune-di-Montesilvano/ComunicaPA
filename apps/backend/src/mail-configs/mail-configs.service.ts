import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { MailServerConfig, MailServerType } from '../entities/mail-server-config.entity';
import { AppSettingsService } from '../settings/app-settings.service';
import { MASKED_VALUE } from '../settings/settings.registry';
import { decryptValue, deriveSettingsKey, encryptValue } from '../settings/settings-crypto';
import type { AppConfiguration } from '../config/configuration';
import type { CreateMailConfigDto, MailConfigMaskedDto, UpdateMailConfigDto } from './dto/mail-config.dto';
import type { SettingKey } from '../settings/settings.registry';

export interface ResolvedMailConfig {
  host: string;
  port: number;
  secure: boolean;
  authEnabled: boolean;
  username: string;
  password: string;
  fromAddress: string;
  batchSize: number;
  batchIntervalSeconds: number;
  configId: string | null;
}

/** Campi che, se modificati, invalidano l'esito del test precedente. */
const TEST_INVALIDATING_FIELDS: Array<keyof UpdateMailConfigDto> = [
  'host', 'port', 'secure', 'authEnabled', 'username', 'password', 'fromAddress',
];

@Injectable()
export class MailConfigsService {
  private readonly logger = new Logger(MailConfigsService.name);
  private readonly cryptoKey: Buffer;

  constructor(
    @InjectRepository(MailServerConfig)
    private readonly repo: Repository<MailServerConfig>,
    private readonly appSettings: AppSettingsService,
    config: ConfigService<AppConfiguration, true>,
  ) {
    this.cryptoKey = deriveSettingsKey(config.get('jwt.secret', { infer: true }));
  }

  private toMasked(entity: MailServerConfig): MailConfigMaskedDto {
    return {
      id: entity.id,
      type: entity.type,
      name: entity.name,
      host: entity.host,
      port: entity.port,
      secure: entity.secure,
      authEnabled: entity.authEnabled,
      username: entity.username,
      password: entity.passwordEnc ? MASKED_VALUE : '',
      fromAddress: entity.fromAddress,
      batchSize: entity.batchSize,
      batchIntervalSeconds: entity.batchIntervalSeconds,
      testedAt: entity.testedAt ? entity.testedAt.toISOString() : null,
      active: entity.active,
    };
  }

  async listMasked(type?: MailServerType): Promise<MailConfigMaskedDto[]> {
    const rows = await this.repo.find({
      where: type ? { type } : {},
      order: { createdAt: 'ASC' },
    });
    return rows.map((r) => this.toMasked(r));
  }

  async create(dto: CreateMailConfigDto): Promise<MailConfigMaskedDto> {
    const entity = this.repo.create({
      type: dto.type,
      name: dto.name,
      host: dto.host,
      port: dto.port,
      secure: dto.secure,
      authEnabled: dto.authEnabled,
      username: dto.username ?? '',
      passwordEnc: dto.password ? encryptValue(dto.password, this.cryptoKey) : '',
      fromAddress: dto.fromAddress,
      batchSize: dto.batchSize,
      batchIntervalSeconds: dto.batchIntervalSeconds,
      testedAt: null,
      active: false,
    });
    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }

  async update(id: string, dto: UpdateMailConfigDto): Promise<MailConfigMaskedDto> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Configurazione ${id} non trovata`);

    const invalidatesTest = TEST_INVALIDATING_FIELDS.some(
      (f) => dto[f] !== undefined && !(f === 'password' && dto.password === MASKED_VALUE),
    );

    if (dto.name !== undefined) entity.name = dto.name;
    if (dto.host !== undefined) entity.host = dto.host;
    if (dto.port !== undefined) entity.port = dto.port;
    if (dto.secure !== undefined) entity.secure = dto.secure;
    if (dto.authEnabled !== undefined) entity.authEnabled = dto.authEnabled;
    if (dto.username !== undefined) entity.username = dto.username;
    if (dto.password !== undefined && dto.password !== MASKED_VALUE) {
      entity.passwordEnc = dto.password ? encryptValue(dto.password, this.cryptoKey) : '';
    }
    if (dto.fromAddress !== undefined) entity.fromAddress = dto.fromAddress;
    if (dto.batchSize !== undefined) entity.batchSize = dto.batchSize;
    if (dto.batchIntervalSeconds !== undefined) entity.batchIntervalSeconds = dto.batchIntervalSeconds;

    if (invalidatesTest) {
      entity.testedAt = null;
      entity.active = false;
    }

    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }

  async remove(id: string): Promise<void> {
    const result = await this.repo.delete({ id });
    if (!result.affected) throw new NotFoundException(`Configurazione ${id} non trovata`);
  }

  async setActive(id: string, active: boolean): Promise<MailConfigMaskedDto> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Configurazione ${id} non trovata`);
    if (active && !entity.testedAt) {
      throw new BadRequestException(
        'La configurazione non è mai stata testata con successo: eseguire prima il test.',
      );
    }
    entity.active = active;
    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }

  private decryptPassword(entity: MailServerConfig): string {
    if (!entity.passwordEnc) return '';
    try {
      return decryptValue(entity.passwordEnc, this.cryptoKey);
    } catch {
      this.logger.warn(`Password della config "${entity.name}" non decifrabile (JWT_SECRET cambiato?): reinserirla da UI.`);
      return '';
    }
  }

  async test(id: string, to: string): Promise<{ success: boolean; message: string }> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Configurazione ${id} non trovata`);
    if (!to) throw new BadRequestException('Destinatario di test richiesto (campo "to")');

    const transporter = nodemailer.createTransport({
      host: entity.host,
      port: entity.port,
      secure: entity.secure,
      auth: entity.authEnabled && entity.username
        ? { user: entity.username, pass: this.decryptPassword(entity) }
        : undefined,
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });

    try {
      await transporter.sendMail({
        from: entity.fromAddress,
        to,
        subject: `ComunicaPA - Test configurazione ${entity.type} "${entity.name}"`,
        text: `Messaggio di test inviato da ComunicaPA per verificare la configurazione "${entity.name}" (${entity.host}:${entity.port}).`,
      });
    } catch (error: any) {
      this.logger.error(`Test ${entity.type} "${entity.name}" fallito: ${error.message}`);
      return { success: false, message: `Errore connessione: ${error.message}` };
    }

    entity.testedAt = new Date();
    entity.active = true;
    await this.repo.save(entity);
    return { success: true, message: 'Messaggio di test inviato: configurazione attivata.' };
  }

  async resolveForSend(type: MailServerType, mailConfigId?: string): Promise<ResolvedMailConfig> {
    if (mailConfigId) {
      const byId = await this.repo.findOneBy({ id: mailConfigId });
      if (byId && byId.type === type) {
        return this.toResolved(byId);
      }
      this.logger.warn(`mailConfigId ${mailConfigId} non trovato o tipo errato: fallback su config attiva ${type}`);
    }

    const actives = await this.repo.find({
      where: { type, active: true },
      order: { createdAt: 'ASC' },
    });
    if (actives.length > 0) {
      return this.toResolved(actives[0]);
    }

    // Fallback legacy: chiavi smtp.*/pec.* dei settings (installazioni pre-migrazione)
    const prefix = type === 'EMAIL' ? 'smtp' : 'pec';
    const key = (suffix: string) => `${prefix}.${suffix}` as SettingKey;
    const username = (await this.appSettings.get<string>(key('user'))) as unknown as string;
    return {
      host: (await this.appSettings.get<string>(key('host'))) as unknown as string,
      port: (await this.appSettings.get<number>(key('port'))) as unknown as number,
      secure: (await this.appSettings.get<boolean>(key('secure'))) as unknown as boolean,
      authEnabled: !!username,
      username,
      password: (await this.appSettings.get<string>(key('password'))) as unknown as string,
      fromAddress: (await this.appSettings.get<string>(key('from'))) as unknown as string,
      batchSize: 100,
      batchIntervalSeconds: 60,
      configId: null,
    };
  }

  private toResolved(entity: MailServerConfig): ResolvedMailConfig {
    return {
      host: entity.host,
      port: entity.port,
      secure: entity.secure,
      authEnabled: entity.authEnabled,
      username: entity.username,
      password: this.decryptPassword(entity),
      fromAddress: entity.fromAddress,
      batchSize: entity.batchSize,
      batchIntervalSeconds: entity.batchIntervalSeconds,
      configId: entity.id,
    };
  }
}
