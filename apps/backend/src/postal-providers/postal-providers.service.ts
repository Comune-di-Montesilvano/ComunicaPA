import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { PostalProviderConfig } from '../entities/postal-provider-config.entity';
import { GlobalComClient, type GbcCredentials } from '../channels/postal/globalcom-client.service';
import { MASKED_VALUE } from '../settings/settings.registry';
import { decryptValue, deriveSettingsKey, encryptValue } from '../settings/settings-crypto';
import type { AppConfiguration } from '../config/configuration';
import type {
  CreatePostalProviderDto,
  PostalProviderMaskedDto,
  UpdatePostalProviderDto,
} from './dto/postal-provider.dto';

export interface ResolvedPostalProvider {
  id: string;
  creds: GbcCredentials;
  centroDiCosto: string;
  mittente: {
    denominazione1: string;
    indirizzo1: string;
    cap: string;
    citta: string;
    provincia: string;
  } | null;
  enabledServiceTypes: string[];
  contratti: Array<{ codiceContratto: string; descrizione: string; tipologia: string }>;
}

/** Campi che, se modificati, invalidano l'audit del test precedente (credenziali/endpoint cambiati). */
const TEST_INVALIDATING_FIELDS: Array<keyof UpdatePostalProviderDto> = [
  'baseUrl', 'username', 'password', 'group',
];

@Injectable()
export class PostalProvidersService {
  private readonly logger = new Logger(PostalProvidersService.name);
  private readonly cryptoKey: Buffer;

  constructor(
    @InjectRepository(PostalProviderConfig)
    private readonly repo: Repository<PostalProviderConfig>,
    private readonly globalCom: GlobalComClient,
    config: ConfigService<AppConfiguration, true>,
  ) {
    this.cryptoKey = deriveSettingsKey(config.get('jwt.secret', { infer: true }));
  }

  private toMasked(entity: PostalProviderConfig): PostalProviderMaskedDto {
    return {
      id: entity.id,
      type: entity.type,
      name: entity.name,
      baseUrl: entity.baseUrl,
      username: entity.username,
      password: entity.passwordEnc ? MASKED_VALUE : '',
      group: entity.group,
      centroDiCosto: entity.centroDiCosto,
      mittenteDenominazione1: entity.mittenteDenominazione1,
      mittenteIndirizzo1: entity.mittenteIndirizzo1,
      mittenteCap: entity.mittenteCap,
      mittenteCitta: entity.mittenteCitta,
      mittenteProvincia: entity.mittenteProvincia,
      enabledServiceTypes: entity.enabledServiceTypes,
      contratti: entity.contratti,
      testedAt: entity.testedAt ? entity.testedAt.toISOString() : null,
      active: entity.active,
    };
  }

  async listMasked(): Promise<PostalProviderMaskedDto[]> {
    const rows = await this.repo.find({ order: { createdAt: 'ASC' } });
    return rows.map((r) => this.toMasked(r));
  }

  async create(dto: CreatePostalProviderDto): Promise<PostalProviderMaskedDto> {
    const entity = this.repo.create({
      type: dto.type,
      name: dto.name,
      baseUrl: dto.baseUrl,
      username: dto.username,
      passwordEnc: dto.password ? encryptValue(dto.password, this.cryptoKey) : '',
      group: dto.group ?? '',
      centroDiCosto: dto.centroDiCosto ?? '',
      mittenteDenominazione1: dto.mittenteDenominazione1 ?? '',
      mittenteIndirizzo1: dto.mittenteIndirizzo1 ?? '',
      mittenteCap: dto.mittenteCap ?? '',
      mittenteCitta: dto.mittenteCitta ?? '',
      mittenteProvincia: dto.mittenteProvincia ?? '',
      enabledServiceTypes: [],
      contratti: [],
      testedAt: null,
      active: false,
    });
    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }

  async update(id: string, dto: UpdatePostalProviderDto): Promise<PostalProviderMaskedDto> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Provider ${id} non trovato`);

    const invalidatesTest = TEST_INVALIDATING_FIELDS.some(
      (f) => dto[f] !== undefined && !(f === 'password' && dto.password === MASKED_VALUE),
    );

    if (dto.name !== undefined) entity.name = dto.name;
    if (dto.baseUrl !== undefined) entity.baseUrl = dto.baseUrl;
    if (dto.username !== undefined) entity.username = dto.username;
    if (dto.password !== undefined && dto.password !== MASKED_VALUE) {
      entity.passwordEnc = dto.password ? encryptValue(dto.password, this.cryptoKey) : '';
    }
    if (dto.group !== undefined) entity.group = dto.group;
    if (dto.centroDiCosto !== undefined) entity.centroDiCosto = dto.centroDiCosto;
    if (dto.mittenteDenominazione1 !== undefined) entity.mittenteDenominazione1 = dto.mittenteDenominazione1;
    if (dto.mittenteIndirizzo1 !== undefined) entity.mittenteIndirizzo1 = dto.mittenteIndirizzo1;
    if (dto.mittenteCap !== undefined) entity.mittenteCap = dto.mittenteCap;
    if (dto.mittenteCitta !== undefined) entity.mittenteCitta = dto.mittenteCitta;
    if (dto.mittenteProvincia !== undefined) entity.mittenteProvincia = dto.mittenteProvincia;

    if (invalidatesTest) {
      entity.testedAt = null;
      entity.active = false;
      entity.enabledServiceTypes = [];
      entity.contratti = [];
    }

    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }

  async remove(id: string): Promise<void> {
    const result = await this.repo.delete({ id });
    if (!result.affected) throw new NotFoundException(`Provider ${id} non trovato`);
  }

  async setActive(id: string, active: boolean): Promise<PostalProviderMaskedDto> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Provider ${id} non trovato`);
    if (active && !entity.testedAt) {
      throw new BadRequestException('Il provider non è mai stato testato con successo: eseguire prima il test.');
    }
    entity.active = active;
    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }

  private decryptPassword(entity: PostalProviderConfig): string {
    if (!entity.passwordEnc) return '';
    try {
      return decryptValue(entity.passwordEnc, this.cryptoKey);
    } catch {
      this.logger.warn(`Password del provider "${entity.name}" non decifrabile (JWT_SECRET cambiato?): reinserirla da UI.`);
      return '';
    }
  }

  private toCreds(entity: PostalProviderConfig): GbcCredentials {
    return {
      baseUrl: entity.baseUrl,
      user: entity.username,
      password: this.decryptPassword(entity),
      group: entity.group,
    };
  }

  /**
   * Chiama InformazioniUtenza (solo lettura, nessun invio) per scoprire
   * automaticamente Servizio abilitati e codici contratto disponibili —
   * l'operatore non deve indovinarli/configurarli a mano.
   */
  async test(id: string): Promise<{ success: boolean; message: string }> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Provider ${id} non trovato`);

    let info;
    try {
      info = await this.globalCom.informazioniUtenza(this.toCreds(entity));
    } catch (error: any) {
      this.logger.error(`Test provider "${entity.name}" fallito: ${error.message}`);
      return { success: false, message: `Errore connessione: ${error.message}` };
    }

    if (!info.operazioneRiuscita) {
      return { success: false, message: info.messaggioErrore || 'Recupero informazioni utenza fallito' };
    }

    entity.enabledServiceTypes = info.prodottiDisponibili;
    entity.contratti = info.contratti;
    if (info.centroDiCosto && !entity.centroDiCosto) entity.centroDiCosto = info.centroDiCosto;
    entity.testedAt = new Date();
    entity.active = true;
    await this.repo.save(entity);

    return {
      success: true,
      message: `Utenza verificata: ${info.prodottiDisponibili.length} tipologie abilitate, ${info.contratti.length} contratti trovati. Provider attivato.`,
    };
  }

  /** Provider attivo per l'invio reale — usato da PostalStrategy/PostalStatusSyncService. */
  async getActive(): Promise<ResolvedPostalProvider | null> {
    const entity = await this.repo.findOne({ where: { active: true }, order: { createdAt: 'ASC' } });
    if (!entity) return null;
    return {
      id: entity.id,
      creds: this.toCreds(entity),
      centroDiCosto: entity.centroDiCosto || undefined as unknown as string,
      mittente: entity.mittenteDenominazione1
        ? {
            denominazione1: entity.mittenteDenominazione1,
            indirizzo1: entity.mittenteIndirizzo1,
            cap: entity.mittenteCap,
            citta: entity.mittenteCitta,
            provincia: entity.mittenteProvincia,
          }
        : null,
      enabledServiceTypes: entity.enabledServiceTypes,
      contratti: entity.contratti,
    };
  }
}
