import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ENTITIES, MIGRATIONS } from './schema.list.js';

// schema.list.ts elenca entity e migration a mano: una migration non registrata
// non gira mai in produzione (migrationsRun), una entity mancante fa proporre
// DROP TABLE a migration:generate. I test/DB temporanei che caricano la cartella
// con un glob passerebbero comunque.
function exportedClasses(dir: string, accept: (f: string) => boolean): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts') && accept(f))
    .map((f) => readFileSync(join(dir, f), 'utf8').match(/export class (\w+)/)?.[1])
    .filter((name): name is string => !!name);
}

describe('schema.list — registrazione', () => {
  it('ogni migration in migrations/ è in MIGRATIONS', () => {
    const names = exportedClasses(join(__dirname, 'migrations'), () => true);
    expect(names.length).toBeGreaterThan(0);
    const registered = MIGRATIONS.map((m) => m.name);
    expect(names.filter((n) => !registered.includes(n))).toEqual([]);
  });

  it('ogni entity in entities/ è in ENTITIES', () => {
    const names = exportedClasses(join(__dirname, '..', 'entities'), (f) => f.endsWith('.entity.ts'));
    expect(names.length).toBeGreaterThan(0);
    const registered = ENTITIES.map((e) => e.name);
    expect(names.filter((n) => !registered.includes(n))).toEqual([]);
  });
});
