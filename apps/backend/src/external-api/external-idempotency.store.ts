import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import type { Redis } from 'ioredis';
import { IDEMPOTENCY_TTL_HOURS } from './external-capabilities.service.js';

export const EXTERNAL_IDEMPOTENCY_REDIS = Symbol('EXTERNAL_IDEMPOTENCY_REDIS');
export type IdempotencyRedis = Pick<Redis, 'set' | 'get' | 'del'>;

export type IdempotencyBegin =
  | { kind: 'new' }
  | { kind: 'replay'; response: unknown }
  | { kind: 'conflict' }
  | { kind: 'in_progress' };

interface Entry {
  state: 'pending' | 'done';
  requestHash: string;
  response?: unknown;
}

const TTL_SECONDS = IDEMPOTENCY_TTL_HOURS * 3600;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}

export function hashRequest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex');
}

/**
 * Un retry del client dopo un timeout non deve creare una seconda notifica
 * (SEND/POSTAL costano). SET NX rende atomica la prenotazione della chiave
 * anche con due richieste concorrenti identiche.
 */
@Injectable()
export class ExternalIdempotencyStore {
  constructor(@Inject(EXTERNAL_IDEMPOTENCY_REDIS) private readonly redis: IdempotencyRedis) {}

  private keyOf(clientId: string, key: string): string {
    return `ext:idem:${clientId}:${createHash('sha256').update(key).digest('hex')}`;
  }

  async begin(clientId: string, key: string, requestHash: string): Promise<IdempotencyBegin> {
    const redisKey = this.keyOf(clientId, key);
    const pending: Entry = { state: 'pending', requestHash };
    const ok = await this.redis.set(redisKey, JSON.stringify(pending), 'EX', TTL_SECONDS, 'NX');
    if (ok === 'OK') return { kind: 'new' };
    const raw = await this.redis.get(redisKey);
    if (!raw) return this.begin(clientId, key, requestHash);
    const entry = JSON.parse(raw) as Entry;
    if (entry.requestHash !== requestHash) return { kind: 'conflict' };
    if (entry.state === 'pending') return { kind: 'in_progress' };
    return { kind: 'replay', response: entry.response };
  }

  async complete(clientId: string, key: string, requestHash: string, response: unknown): Promise<void> {
    const done: Entry = { state: 'done', requestHash, response };
    await this.redis.set(this.keyOf(clientId, key), JSON.stringify(done), 'EX', TTL_SECONDS);
  }

  async release(clientId: string, key: string): Promise<void> {
    await this.redis.del(this.keyOf(clientId, key));
  }
}
