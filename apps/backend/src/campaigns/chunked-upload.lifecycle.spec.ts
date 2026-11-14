import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  apiClientUploadOwner,
  assembleChunkedUpload,
  assertChunkedUploadAccess,
  CHUNK_SESSION_MAX_AGE_MS,
  chunkedUploadAccess,
  chunkUploadDir,
  cleanupChunkedUpload,
  initChunkedUpload,
  operatorUploadOwner,
  sweepStaleChunkedUploads,
} from './chunked-upload.util.js';

/**
 * Ciclo di vita delle sessioni di upload a chunk: sessione legata a chi l'ha
 * aperta, errori HTTP espliciti (400 forma, 404 sessione) invece di Error
 * generici, pulizia periodica delle sessioni abbandonate.
 */

const OWNER_A = operatorUploadOwner({ sub: 'operatore-a' });
const OWNER_B = operatorUploadOwner({ sub: 'operatore-b' });

describe('sessione di upload legata a chi la apre', () => {
  const created: string[] = [];
  afterAll(() => created.forEach((id) => cleanupChunkedUpload(id)));

  function init(owner?: string): string {
    const id = initChunkedUpload('elenco.csv', 1, owner);
    created.push(id);
    return id;
  }

  it('owner distinti per operatori e client API, mai sovrapponibili', () => {
    expect(OWNER_A).toBe('operator:operatore-a');
    expect(apiClientUploadOwner('operatore-a')).toBe('api:operatore-a');
    expect(operatorUploadOwner(undefined)).toBeUndefined();
    expect(operatorUploadOwner({})).toBeUndefined();
  });

  it('init salva l’owner nei metadati della sessione', () => {
    const id = init(OWNER_A);
    const meta = JSON.parse(fs.readFileSync(join(chunkUploadDir(id), 'meta.json'), 'utf8'));
    expect(meta.owner).toBe(OWNER_A);
  });

  it('stesso owner → ok; owner diverso o assente → not-found (stessa risposta di una sessione inesistente)', () => {
    const id = init(OWNER_A);
    expect(chunkedUploadAccess(id, OWNER_A)).toBe('ok');
    expect(chunkedUploadAccess(id, OWNER_B)).toBe('not-found');
    expect(chunkedUploadAccess(id, undefined)).toBe('not-found');
    expect(chunkedUploadAccess(randomUUID(), OWNER_A)).toBe('not-found');
  });

  it('sessione creata prima del campo owner (meta senza owner) → accettata da chiunque', () => {
    const id = init();
    const meta = JSON.parse(fs.readFileSync(join(chunkUploadDir(id), 'meta.json'), 'utf8'));
    expect(meta).not.toHaveProperty('owner');
    expect(chunkedUploadAccess(id, OWNER_B)).toBe('ok');
  });

  it('cartella senza meta.json (sessione incompleta) → not-found', () => {
    const id = init(OWNER_A);
    fs.rmSync(join(chunkUploadDir(id), 'meta.json'));
    expect(chunkedUploadAccess(id, OWNER_A)).toBe('not-found');
  });

  it.each([['../../../../etc'], [''], [undefined], [42]])('uploadId %s → invalid, mai un throw', (id) => {
    expect(chunkedUploadAccess(id, OWNER_A)).toBe('invalid');
  });

  it('assertChunkedUploadAccess: 400 per la forma, 404 per sessione inesistente o altrui', () => {
    const id = init(OWNER_A);
    expect(() => assertChunkedUploadAccess('../../etc', OWNER_A)).toThrow(BadRequestException);
    expect(() => assertChunkedUploadAccess(randomUUID(), OWNER_A)).toThrow(NotFoundException);
    expect(() => assertChunkedUploadAccess(id, OWNER_B)).toThrow(NotFoundException);
    expect(() => assertChunkedUploadAccess(id, OWNER_A)).not.toThrow();
  });

  it('assembleChunkedUpload: uploadId malformato → BadRequestException, sessione inesistente → NotFoundException', async () => {
    await expect(assembleChunkedUpload('../../../../etc')).rejects.toBeInstanceOf(BadRequestException);
    await expect(assembleChunkedUpload(randomUUID())).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('sweepStaleChunkedUploads', () => {
  let root: string;
  let outside: string;
  const NOW = Date.parse('2026-11-14T12:00:00Z');
  const OLD = new Date(NOW - CHUNK_SESSION_MAX_AGE_MS - 60_000);
  const FRESH = new Date(NOW - 60_000);

  function session(name: string, mtime: Date): string {
    const dir = join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(join(dir, 'meta.json'), '{}');
    fs.writeFileSync(join(dir, '0.part'), 'x');
    fs.utimesSync(join(dir, 'meta.json'), mtime, mtime);
    fs.utimesSync(join(dir, '0.part'), mtime, mtime);
    fs.utimesSync(dir, mtime, mtime);
    return dir;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chunk-sweep-'));
    outside = mkdtempSync(join(tmpdir(), 'chunk-sweep-outside-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('CHUNK_SESSION_MAX_AGE_MS = 24 h', () => {
    expect(CHUNK_SESSION_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('rimuove solo le sessioni (cartelle UUID) più vecchie di 24 h', () => {
    const old = session(randomUUID(), OLD);
    const fresh = session(randomUUID(), FRESH);

    expect(sweepStaleChunkedUploads(root, CHUNK_SESSION_MAX_AGE_MS, NOW)).toBe(1);

    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(join(fresh, '0.part'))).toBe(true);
  });

  it('ignora cartelle con nome non UUID e file con nome UUID', () => {
    const notUuid = session('non-una-sessione', OLD);
    const fileName = join(root, randomUUID());
    fs.writeFileSync(fileName, 'x');
    fs.utimesSync(fileName, OLD, OLD);

    expect(sweepStaleChunkedUploads(root, CHUNK_SESSION_MAX_AGE_MS, NOW)).toBe(0);

    expect(fs.existsSync(join(notUuid, 'meta.json'))).toBe(true);
    expect(fs.existsSync(fileName)).toBe(true);
  });

  it('symlink con nome UUID verso una cartella fuori dalla radice: mai seguito né svuotato', () => {
    fs.writeFileSync(join(outside, 'dato.pdf'), '%PDF-1.4');
    fs.utimesSync(outside, OLD, OLD);
    const link = join(root, randomUUID());
    fs.symlinkSync(outside, link, 'dir');

    expect(sweepStaleChunkedUploads(root, CHUNK_SESSION_MAX_AGE_MS, NOW)).toBe(0);

    expect(fs.readFileSync(join(outside, 'dato.pdf'), 'utf8')).toBe('%PDF-1.4');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('radice inesistente → 0, nessun errore', () => {
    expect(sweepStaleChunkedUploads(join(root, 'manca'), CHUNK_SESSION_MAX_AGE_MS, NOW)).toBe(0);
  });
});
