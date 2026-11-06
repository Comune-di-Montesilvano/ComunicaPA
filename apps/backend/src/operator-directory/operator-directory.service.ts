import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { OperatorDirectoryEntry } from '../entities/operator-directory-entry.entity.js';

@Injectable()
export class OperatorDirectoryService {
  constructor(
    @InjectRepository(OperatorDirectoryEntry)
    private readonly repo: Repository<OperatorDirectoryEntry>,
  ) {}

  async upsert(username: string, displayName: string): Promise<void> {
    await this.repo.upsert({ username, displayName }, ['username']);
  }

  async listAll(): Promise<Array<{ username: string; displayName: string }>> {
    const entries = await this.repo.find({
      select: { username: true, displayName: true },
      order: { displayName: 'ASC' },
    });
    return entries.map((e) => ({ username: e.username, displayName: e.displayName }));
  }

  exists(username: string): Promise<boolean> {
    return this.repo.existsBy({ username });
  }

  async resolveMany(usernames: string[]): Promise<Record<string, string>> {
    const unique = [...new Set(usernames)].filter(Boolean);
    if (unique.length === 0) return {};
    const entries = await this.repo.find({ where: { username: In(unique) } });
    return Object.fromEntries(entries.map((e) => [e.username, e.displayName]));
  }
}
