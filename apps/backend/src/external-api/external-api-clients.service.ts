import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes, createHash } from 'crypto';
import { ExternalApiClient } from '../entities/external-api-client.entity';

export interface ExternalApiClientMaskedDto {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

function hashKey(apiKeyPlain: string): string {
  return createHash('sha256').update(apiKeyPlain).digest('hex');
}

function generatePlainKey(): string {
  return randomBytes(32).toString('base64url');
}

@Injectable()
export class ExternalApiClientsService {
  constructor(
    @InjectRepository(ExternalApiClient)
    private readonly repo: Repository<ExternalApiClient>,
  ) {}

  private toMasked(entity: ExternalApiClient): ExternalApiClientMaskedDto {
    return {
      id: entity.id,
      name: entity.name,
      active: entity.active,
      createdAt: entity.createdAt.toISOString(),
      lastUsedAt: entity.lastUsedAt ? entity.lastUsedAt.toISOString() : null,
    };
  }

  async listMasked(): Promise<ExternalApiClientMaskedDto[]> {
    const rows = await this.repo.find({ order: { createdAt: 'DESC' } });
    return rows.map((r) => this.toMasked(r));
  }

  async generateKey(name: string): Promise<{ client: ExternalApiClientMaskedDto; apiKeyPlain: string }> {
    const apiKeyPlain = generatePlainKey();
    const entity = this.repo.create({ name, apiKeyHash: hashKey(apiKeyPlain), active: true, lastUsedAt: null });
    const saved = await this.repo.save(entity);
    return { client: this.toMasked(saved), apiKeyPlain };
  }

  async regenerateKey(id: string): Promise<{ client: ExternalApiClientMaskedDto; apiKeyPlain: string }> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`Client ${id} non trovato`);
    const apiKeyPlain = generatePlainKey();
    entity.apiKeyHash = hashKey(apiKeyPlain);
    const saved = await this.repo.save(entity);
    return { client: this.toMasked(saved), apiKeyPlain };
  }

  async revoke(id: string): Promise<void> {
    const result = await this.repo.update({ id }, { active: false });
    if (!result.affected) throw new NotFoundException(`Client ${id} non trovato`);
  }

  /** Nessuna eccezione: guard e chiamante decidono cosa fare di un `null`. */
  async findActiveByKey(apiKeyPlain: string): Promise<ExternalApiClient | null> {
    return this.repo.findOneBy({ apiKeyHash: hashKey(apiKeyPlain), active: true });
  }

  /** Fire-and-forget lato chiamante: non deve mai bloccare la risposta. */
  async touchLastUsed(id: string): Promise<void> {
    await this.repo.update({ id }, { lastUsedAt: new Date() });
  }
}
