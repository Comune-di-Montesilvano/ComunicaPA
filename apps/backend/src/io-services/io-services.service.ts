import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { IoServiceConfig } from '../entities/io-service-config.entity';
import { decryptValue, deriveSettingsKey, encryptValue } from '../settings/settings-crypto';
import { MASKED_VALUE } from '../settings/settings.registry';
import type { AppConfiguration } from '../config/configuration';
import type { CreateIoServiceDto, IoServiceMaskedDto, UpdateIoServiceDto } from './dto/io-service.dto';

@Injectable()
export class IoServicesService {
  private readonly cryptoKey: Buffer;

  constructor(
    @InjectRepository(IoServiceConfig)
    private readonly repo: Repository<IoServiceConfig>,
    config: ConfigService<AppConfiguration, true>,
  ) {
    this.cryptoKey = deriveSettingsKey(config.get('jwt.secret', { infer: true }));
  }

  private toMasked(entity: IoServiceConfig): IoServiceMaskedDto {
    return {
      id: entity.id,
      nome: entity.nome,
      idService: entity.idService,
      descrizione: entity.descrizione,
      apiKeyPrimaria: entity.apiKeyPrimariaEnc ? MASKED_VALUE : '',
      apiKeySecondaria: entity.apiKeySecondariaEnc ? MASKED_VALUE : '',
      codiceCatalogo: entity.codiceCatalogo,
      isDefault: entity.isDefault,
      testedAt: entity.testedAt ? entity.testedAt.toISOString() : null,
    };
  }

  async listMasked(): Promise<IoServiceMaskedDto[]> {
    const rows = await this.repo.find({ order: { createdAt: 'ASC' } });
    return rows.map((r) => this.toMasked(r));
  }

  async create(dto: CreateIoServiceDto): Promise<IoServiceMaskedDto> {
    if (dto.isDefault) {
      await this.repo.update({ isDefault: true }, { isDefault: false });
    }
    const entity = this.repo.create({
      nome: dto.nome,
      idService: dto.idService,
      descrizione: dto.descrizione ?? '',
      apiKeyPrimariaEnc: encryptValue(dto.apiKeyPrimaria, this.cryptoKey),
      apiKeySecondariaEnc: dto.apiKeySecondaria ? encryptValue(dto.apiKeySecondaria, this.cryptoKey) : '',
      codiceCatalogo: dto.codiceCatalogo ?? '',
      isDefault: dto.isDefault ?? false,
      testedAt: null,
    });
    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }

  async update(id: string, dto: UpdateIoServiceDto): Promise<IoServiceMaskedDto> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Servizio App IO ${id} non trovato`);

    if (dto.nome !== undefined) entity.nome = dto.nome;
    if (dto.idService !== undefined) entity.idService = dto.idService;
    if (dto.descrizione !== undefined) entity.descrizione = dto.descrizione;
    if (dto.apiKeyPrimaria !== undefined && dto.apiKeyPrimaria !== MASKED_VALUE) {
      entity.apiKeyPrimariaEnc = encryptValue(dto.apiKeyPrimaria, this.cryptoKey);
    }
    if (dto.apiKeySecondaria !== undefined && dto.apiKeySecondaria !== MASKED_VALUE) {
      entity.apiKeySecondariaEnc = dto.apiKeySecondaria ? encryptValue(dto.apiKeySecondaria, this.cryptoKey) : '';
    }
    if (dto.codiceCatalogo !== undefined) entity.codiceCatalogo = dto.codiceCatalogo;

    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }

  async remove(id: string): Promise<void> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Servizio App IO ${id} non trovato`);
    if (entity.isDefault) {
      const count = await this.repo.count();
      if (count > 1) {
        throw new BadRequestException('Imposta un altro servizio come predefinito prima di eliminare questo.');
      }
    }
    await this.repo.delete({ id });
  }

  async setDefault(id: string): Promise<IoServiceMaskedDto> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Servizio App IO ${id} non trovato`);
    await this.repo.update({ isDefault: true }, { isDefault: false });
    entity.isDefault = true;
    const saved = await this.repo.save(entity);
    return this.toMasked(saved);
  }

  async test(id: string, codiceFiscale: string): Promise<{ success: true; message: string }> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Servizio App IO ${id} non trovato`);
    if (!codiceFiscale) throw new BadRequestException('Codice fiscale di test richiesto');

    const apiKey = decryptValue(entity.apiKeyPrimariaEnc, this.cryptoKey);
    const { APP_IO_BASE_URL } = await import('../channels/app-io/app-io.strategy');
    const response = await fetch(`${APP_IO_BASE_URL}/api/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Ocp-Apim-Subscription-Key': apiKey },
      body: JSON.stringify({
        fiscal_code: codiceFiscale,
        content: { subject: `Test ComunicaPA - ${entity.nome}`, markdown: `Messaggio di test dal servizio **${entity.nome}**.` },
      }),
    });

    if (!response.ok) {
      throw new BadRequestException(`Errore App IO: HTTP ${response.status}`);
    }

    entity.testedAt = new Date();
    await this.repo.save(entity);
    return { success: true, message: 'Messaggio di test inviato con successo.' };
  }

  async resolveApiKey(idOrUndefined?: string): Promise<{ apiKey: string; idService: string } | null> {
    let entity: IoServiceConfig | null = null;
    if (idOrUndefined) {
      entity = await this.repo.findOneBy({ id: idOrUndefined });
    }
    if (!entity) {
      const defaults = await this.repo.find({ where: { isDefault: true } });
      entity = defaults[0] ?? null;
    }
    if (!entity || !entity.apiKeyPrimariaEnc) return null;
    return { apiKey: decryptValue(entity.apiKeyPrimariaEnc, this.cryptoKey), idService: entity.idService };
  }
}
