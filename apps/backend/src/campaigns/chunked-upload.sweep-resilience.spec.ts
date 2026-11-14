import { vi } from 'vitest';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// `fs` parzialmente mockato (stesso motivo di external-attachment-tokens.service.spec:
// jest.spyOn sul namespace di un builtin fallisce): rmSync/lstatSync delegano
// all'implementazione reale salvo i path scelti dal test.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync), lstatSync: vi.fn(actual.lstatSync) };
});

const { CHUNK_SESSION_MAX_AGE_MS, sweepStaleChunkedUploads } = await import('./chunked-upload.util.js');
const actualFs = await vi.importActual<typeof import('fs')>('fs');

/** Una voce che sparisce o non si lascia rimuovere non deve fermare la pulizia delle altre. */
describe('sweepStaleChunkedUploads — errori su singole voci', () => {
  let root: string;
  const NOW = Date.parse('2026-11-14T12:00:00Z');
  const OLD = new Date(NOW - CHUNK_SESSION_MAX_AGE_MS - 60_000);

  function oldSession(): string {
    const dir = join(root, randomUUID());
    actualFs.mkdirSync(dir);
    actualFs.writeFileSync(join(dir, 'meta.json'), '{}');
    actualFs.utimesSync(dir, OLD, OLD);
    return dir;
  }

  beforeEach(() => {
    root = actualFs.mkdtempSync(join(tmpdir(), 'chunk-sweep-err-'));
  });

  afterEach(() => {
    (fs.rmSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(actualFs.rmSync);
    (fs.lstatSync as unknown as ReturnType<typeof vi.fn>).mockImplementation(actualFs.lstatSync);
    actualFs.rmSync(root, { recursive: true, force: true });
  });

  it('rmSync che fallisce (EBUSY) su una sessione: le altre vengono comunque rimosse', () => {
    const busy = oldSession();
    const others = [oldSession(), oldSession()];
    (fs.rmSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((p: fs.PathLike, opts?: fs.RmOptions) => {
      if (p === busy) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return actualFs.rmSync(p, opts);
    });

    expect(sweepStaleChunkedUploads(root, CHUNK_SESSION_MAX_AGE_MS, NOW)).toBe(2);

    expect(actualFs.existsSync(busy)).toBe(true);
    for (const dir of others) expect(actualFs.existsSync(dir)).toBe(false);
  });

  it('sessione sparita tra readdir e lstat (complete concorrente): ignorata, le altre rimosse', () => {
    const vanishing = oldSession();
    const other = oldSession();
    (fs.lstatSync as unknown as ReturnType<typeof vi.fn>).mockImplementation((p: fs.PathLike, opts?: fs.StatSyncOptions) => {
      if (p === vanishing) {
        actualFs.rmSync(vanishing, { recursive: true, force: true });
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return actualFs.lstatSync(p, opts);
    });

    expect(sweepStaleChunkedUploads(root, CHUNK_SESSION_MAX_AGE_MS, NOW)).toBe(1);

    expect(actualFs.existsSync(other)).toBe(false);
  });
});
