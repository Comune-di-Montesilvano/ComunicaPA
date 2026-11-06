import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// database.module.ts elenca le migration a mano: una migration presente in
// migrations/ ma non registrata lì non gira mai in produzione (migrationsRun),
// mentre i test/DB temporanei che caricano la cartella con un glob passano.
describe('database.module — registrazione migration', () => {
  it('ogni migration in migrations/ è importata e registrata', () => {
    const dir = join(__dirname, 'migrations');
    const moduleSource = readFileSync(join(__dirname, 'database.module.ts'), 'utf8');
    const migrationsArray = moduleSource.match(/migrations:\s*\[([^\]]*)\]/)?.[1] ?? '';

    const missing = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .map((f) => readFileSync(join(dir, f), 'utf8').match(/export class (\w+)/)?.[1])
      .filter((name): name is string => !!name)
      .filter((name) => !new RegExp(`\\b${name}\\b`).test(migrationsArray));

    expect(missing).toEqual([]);
  });
});
