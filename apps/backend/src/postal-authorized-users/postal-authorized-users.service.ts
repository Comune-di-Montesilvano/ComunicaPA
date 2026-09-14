import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PostalAuthorizedUser } from '../entities/postal-authorized-user.entity.js';
import { OperatorDirectoryService } from '../operator-directory/operator-directory.service.js';
import type { PostalAuthorizedUserDto } from './dto/postal-authorized-user.dto.js';

@Injectable()
export class PostalAuthorizedUsersService {
  constructor(
    @InjectRepository(PostalAuthorizedUser)
    private readonly repo: Repository<PostalAuthorizedUser>,
    private readonly operatorDirectory: OperatorDirectoryService,
  ) {}

  private normalize(username: string): string {
    return username.trim().toLowerCase();
  }

  async isAuthorized(username: string): Promise<boolean> {
    return this.repo.existsBy({ username: this.normalize(username) });
  }

  async list(): Promise<PostalAuthorizedUserDto[]> {
    const rows = await this.repo.find({ order: { createdAt: 'DESC' } });
    const displayNames = await this.operatorDirectory.resolveMany(rows.map((r) => r.addedBy));
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      addedBy: r.addedBy,
      addedByDisplayName: displayNames[r.addedBy],
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async create(username: string, addedBy: string): Promise<PostalAuthorizedUserDto> {
    const normalized = this.normalize(username);
    if (!normalized) {
      throw new BadRequestException('Username non valido');
    }
    // Pre-check invece di catturare il vincolo unique del driver Postgres:
    // race tra due admin che aggiungono lo stesso utente nello stesso
    // istante è un edge case trascurabile per un CRUD amministrativo.
    const exists = await this.repo.existsBy({ username: normalized });
    if (exists) {
      throw new BadRequestException('Utente già abilitato');
    }
    const entity = this.repo.create({ username: normalized, addedBy });
    const saved = await this.repo.save(entity);
    return {
      id: saved.id,
      username: saved.username,
      addedBy: saved.addedBy,
      createdAt: saved.createdAt.toISOString(),
    };
  }

  async remove(id: string): Promise<void> {
    const result = await this.repo.delete({ id });
    if (!result.affected) {
      throw new NotFoundException(`Utente abilitato ${id} non trovato`);
    }
  }
}
