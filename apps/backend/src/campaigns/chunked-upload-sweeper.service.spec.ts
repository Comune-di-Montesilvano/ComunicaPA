import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ChunkedUploadSweeperService } from './chunked-upload-sweeper.service.js';
import { CHUNK_SESSION_MAX_AGE_MS } from './chunked-upload.util.js';

describe('ChunkedUploadSweeperService', () => {
  let root: string;
  const NOW = Date.parse('2026-11-14T12:00:00Z');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chunk-sweeper-svc-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('rimuove le sessioni scadute e logga solo il numero, senza nomi di file', () => {
    const old = new Date(NOW - CHUNK_SESSION_MAX_AGE_MS - 1000);
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) {
      const dir = join(root, id);
      fs.mkdirSync(dir);
      fs.writeFileSync(join(dir, 'meta.json'), JSON.stringify({ filename: 'ROSSI_MARIO.pdf', totalChunks: 1 }));
      fs.utimesSync(dir, old, old);
    }
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    expect(new ChunkedUploadSweeperService().run(root, NOW)).toBe(2);

    expect(fs.readdirSync(root)).toEqual([]);
    expect(log).toHaveBeenCalledTimes(1);
    const message = String(log.mock.calls[0]![0]);
    expect(message).toContain('2');
    expect(message).not.toContain('ROSSI_MARIO');
    for (const id of ids) expect(message).not.toContain(id);
  });

  it('nessuna sessione scaduta → nessun log', () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    expect(new ChunkedUploadSweeperService().run(root, NOW)).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it('errore del filesystem → warn, mai un throw dal cron', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    // Radice che è un file: readdirSync fallisce con ENOTDIR.
    const notADir = join(root, 'file');
    fs.writeFileSync(notADir, 'x');
    expect(() => new ChunkedUploadSweeperService().run(notADir, NOW)).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
