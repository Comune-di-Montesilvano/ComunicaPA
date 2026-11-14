import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ChunkedUploadSweeperService } from './chunked-upload-sweeper.service.js';
import { CHUNK_SESSION_MAX_AGE_MS } from './chunked-upload.util.js';
import { UPLOAD_BATCH_MAX_AGE_MS } from '../enrichment/enrichment-batch-upload.util.js';

describe('ChunkedUploadSweeperService', () => {
  let base: string;
  let roots: { chunkRoot: string; batchRoot: string };
  const NOW = Date.parse('2026-11-14T12:00:00Z');

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'chunk-sweeper-svc-'));
    roots = { chunkRoot: join(base, 'chunked'), batchRoot: join(base, 'enrichment-batch') };
    fs.mkdirSync(roots.chunkRoot);
    fs.mkdirSync(roots.batchRoot);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function oldDir(root: string, maxAge: number, file: string, content: string): string {
    const old = new Date(NOW - maxAge - 1000);
    const id = randomUUID();
    const dir = join(root, id);
    fs.mkdirSync(dir);
    fs.writeFileSync(join(dir, file), content);
    fs.utimesSync(dir, old, old);
    return id;
  }

  it('rimuove le sessioni scadute e logga solo il numero, senza nomi di file', () => {
    const ids = [1, 2].map(() =>
      oldDir(roots.chunkRoot, CHUNK_SESSION_MAX_AGE_MS, 'meta.json', JSON.stringify({ filename: 'ROSSI_MARIO.pdf', totalChunks: 1 })),
    );
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    expect(new ChunkedUploadSweeperService().run(NOW, roots)).toEqual({ chunkSessions: 2, uploadBatches: 0 });

    expect(fs.readdirSync(roots.chunkRoot)).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    const message = String(log.mock.calls[0]![0]);
    expect(message).toContain('2');
    expect(message).not.toContain('ROSSI_MARIO');
    for (const id of ids) expect(message).not.toContain(id);
  });

  it('stesso cron: rimuove anche i lotti di arricchimento scaduti non completati, logga solo il numero', () => {
    const stale = oldDir(roots.batchRoot, UPLOAD_BATCH_MAX_AGE_MS, '0000_ROSSI_MARIO.zip', 'zip');
    const completed = oldDir(roots.batchRoot, UPLOAD_BATCH_MAX_AGE_MS, '0000_a.zip', 'zip');
    // Marcatore di completamento = directory `.completed` (recente: job ancora in coda).
    const marker = join(roots.batchRoot, completed, '.completed');
    fs.mkdirSync(marker);
    const recent = new Date(NOW - 60_000);
    fs.utimesSync(marker, recent, recent);
    const old = new Date(NOW - UPLOAD_BATCH_MAX_AGE_MS - 1000);
    fs.utimesSync(join(roots.batchRoot, completed), old, old);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    expect(new ChunkedUploadSweeperService().run(NOW, roots)).toEqual({ chunkSessions: 0, uploadBatches: 1 });

    expect(fs.readdirSync(roots.batchRoot)).toEqual([completed]);
    expect(log).toHaveBeenCalledTimes(1);
    const message = String(log.mock.calls[0]![0]);
    expect(message).toContain('1');
    expect(message).not.toContain('ROSSI_MARIO');
    expect(message).not.toContain(stale);
  });

  it('nessuna sessione scaduta → nessun log', () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    expect(new ChunkedUploadSweeperService().run(NOW, roots)).toEqual({ chunkSessions: 0, uploadBatches: 0 });
    expect(log).not.toHaveBeenCalled();
  });

  it('errore del filesystem su una radice → warn, l’altra viene pulita lo stesso, mai un throw dal cron', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    // Radice che è un file: readdirSync fallisce con ENOTDIR.
    const notADir = join(base, 'file');
    fs.writeFileSync(notADir, 'x');
    oldDir(roots.batchRoot, UPLOAD_BATCH_MAX_AGE_MS, '0000_a.zip', 'zip');

    let result: unknown;
    expect(() => {
      result = new ChunkedUploadSweeperService().run(NOW, { chunkRoot: notADir, batchRoot: roots.batchRoot });
    }).not.toThrow();
    expect(result).toEqual({ chunkSessions: 0, uploadBatches: 1 });
    expect(warn).toHaveBeenCalled();
  });
});
