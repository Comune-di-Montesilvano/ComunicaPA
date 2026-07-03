import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { AppSetting } from '../entities/app-setting.entity';
import type { AppConfiguration } from '../config/configuration';
import {
  MASKED_VALUE,
  SETTING_DEFS,
  isSettingKey,
  type SettingDef,
  type SettingKey,
  type SettingValue,
} from './settings.registry';
import { decryptValue, deriveSettingsKey, encryptValue } from './settings-crypto';

@Injectable()
export class AppSettingsService {
  private readonly logger = new Logger(AppSettingsService.name);
  private readonly cache = new Map<SettingKey, SettingValue>();
  private readonly cryptoKey: Buffer;

  constructor(
    @InjectRepository(AppSetting)
    private readonly repo: Repository<AppSetting>,
    config: ConfigService<AppConfiguration, true>,
  ) {
    this.cryptoKey = deriveSettingsKey(config.get('jwt.secret', { infer: true }));
  }

  async get<T extends SettingValue>(key: SettingKey): Promise<T> {
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached as T;
    }

    const def = SETTING_DEFS[key] as SettingDef;

    // Bootstrap: solo env/default, il DB viene ignorato (anche righe legacy)
    if (def.bootstrapOnly) {
      let bootstrapValue = this.envOrDefault(def);
      // L'URL API pubblico deriva dall'origine cittadini: /api è una costante
      // della topologia (il nginx del frontend proxya /api → backend).
      // PUBLIC_BACKEND_URL resta come override esplicito (usato in dev).
      const citizenOrigin = process.env['PUBLIC_CITIZEN_URL'];
      if (key === 'system.publicUrl' && !process.env['PUBLIC_BACKEND_URL'] && citizenOrigin) {
        bootstrapValue = `${citizenOrigin.replace(/\/+$/, '')}/api`;
      }
      this.cache.set(key, bootstrapValue);
      return bootstrapValue as T;
    }

    const row = await this.repo.findOneBy({ key });

    if (row) {
      if (row.encrypted) {
        try {
          const plain = decryptValue(String(row.value), this.cryptoKey);
          this.cache.set(key, plain);
          return plain as T;
        } catch {
          // JWT_SECRET cambiato: il valore va reinserito da UI. Fallback env/default.
          this.logger.warn(`Impossibile decifrare il setting "${key}": reinserirlo dalla UI.`);
        }
      } else {
        this.cache.set(key, row.value);
        return row.value as T;
      }
    }

    const value = this.envOrDefault(def);
    this.cache.set(key, value);
    return value as T;
  }

  async getAllMasked(): Promise<Record<SettingKey, SettingValue>> {
    const result = {} as Record<SettingKey, SettingValue>;
    for (const key of Object.keys(SETTING_DEFS) as SettingKey[]) {
      const def = SETTING_DEFS[key] as SettingDef;
      const value = await this.get(key);
      result[key] = def.secret ? (value ? MASKED_VALUE : '') : value;
    }
    return result;
  }

  async setMany(entries: Record<string, SettingValue>, updatedBy: string): Promise<void> {
    const validated: Array<{ key: SettingKey; def: SettingDef; value: SettingValue }> = [];

    for (const [key, value] of Object.entries(entries)) {
      if (!isSettingKey(key)) {
        throw new BadRequestException(
          `Chiave sconosciuta: "${key}". Chiavi valide: ${Object.keys(SETTING_DEFS).join(', ')}`,
        );
      }
      const def = SETTING_DEFS[key] as SettingDef;
      if (def.bootstrapOnly) {
        continue; // configurabile solo da .env: ignora silenziosamente (client vecchi la inviano ancora)
      }
      if (def.secret && value === MASKED_VALUE) {
        continue; // valore mascherato dalla UI: non toccare quello salvato
      }
      if (typeof value !== def.type) {
        throw new BadRequestException(`Il setting "${key}" richiede tipo ${def.type}`);
      }
      validated.push({ key, def, value });
    }

    for (const { key, def, value } of validated) {
      const entity = new AppSetting();
      entity.key = key;
      entity.encrypted = def.secret === true;
      entity.value = def.secret ? encryptValue(String(value), this.cryptoKey) : value;
      entity.updatedBy = updatedBy;
      await this.repo.save(entity);
    }

    this.clearCache();
  }

  clearCache(): void {
    this.cache.clear();
  }

  private envOrDefault(def: SettingDef): SettingValue {
    const raw = def.env ? process.env[def.env] : undefined;
    if (raw === undefined || raw === '') {
      return def.default;
    }
    switch (def.type) {
      case 'number': {
        const n = Number(raw);
        return Number.isFinite(n) ? n : def.default;
      }
      case 'boolean':
        return raw === 'true';
      default:
        return raw;
    }
  }
}
