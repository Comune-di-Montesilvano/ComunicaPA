import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { DataSource } from 'typeorm';
import { ENTITIES } from './schema.list.js';

// DataSource per la CLI TypeORM (migration:generate / migration:run).
// Il runtime dell'app usa database.module.ts: entity e migration vivono in schema.list.ts
// (se disallineate, migration:generate può proporre DROP TABLE per le entity mancanti).
const __dirname = dirname(fileURLToPath(import.meta.url));

export default new DataSource({
  type: 'postgres',
  url: process.env['DATABASE_URL'],
  entities: ENTITIES,
  migrations: [`${__dirname}/migrations/*.{ts,js}`],
});
