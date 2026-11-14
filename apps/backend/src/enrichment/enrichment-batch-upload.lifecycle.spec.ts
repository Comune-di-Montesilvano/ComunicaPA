import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { operatorUploadOwner } from '../campaigns/chunked-upload.util.js';
import {
  addToUploadBatch,
  assertUploadBatchAccess,
  claimUploadBatch,
  cleanupUploadBatch,
  initUploadBatch,
  listUploadBatchFiles,
  sweepStaleUploadBatches,
  UPLOAD_BATCH_COMPLETED_MAX_AGE_MS,
  UPLOAD_BATCH_MAX_AGE_MS,
  UPLOAD_BATCH_ROOT,
  uploadBatchAccess,
} from './enrichment-batch-upload.util.js';

/**
 * Ciclo di vita dei lotti di upload dell'arricchimento: lotto legato a chi
 * l'ha aperto, errori HTTP espliciti (400 forma, 404 lotto), completamento
 * una sola volta, pulizia periodica dei lotti abbandonati.
 */

const OWNER_A = operatorUploadOwner({ sub: 'operatore-a' });
const OWNER_B = operatorUploadOwner({ sub: 'operatore-b' });

describe('lotto di upload legato a chi lo apre', () => {
  const created: string[] = [];
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'batch-lifecycle-'));
  });
  afterAll(() => {
    created.forEach((id) => cleanupUploadBatch(id));
    rmSync(tmp, { recursive: true, force: true });
  });

  function init(owner?: string): string {
    const id = initUploadBatch(owner);
    created.push(id);
    return id;
  }

  function assembled(name: string): string {
    const p = join(tmp, `${randomUUID()}-${name}`);
    fs.writeFileSync(p, 'zip');
    return p;
  }

  it('lo stesso operatore accede al proprio lotto', () => {
    expect(uploadBatchAccess(init(OWNER_A), OWNER_A)).toBe('ok');
  });

  it('un altro operatore (o nessun utente) riceve la stessa risposta di un lotto inesistente', () => {
    const id = init(OWNER_A);
    expect(uploadBatchAccess(id, OWNER_B)).toBe('not-found');
    expect(uploadBatchAccess(id, undefined)).toBe('not-found');
    expect(uploadBatchAccess(randomUUID(), OWNER_A)).toBe('not-found');
  });

  it('lotto senza owner (creato prima del campo) accettato da chiunque', () => {
    const id = init(undefined);
    expect(uploadBatchAccess(id, OWNER_A)).toBe('ok');
    expect(uploadBatchAccess(id, OWNER_B)).toBe('ok');
  });

  it('lotto creato prima della modifica (cartella senza file di metadati) accettato', () => {
    // Creato dall'API, poi tolto il file di metadati: nessuna scrittura a mano nella radice.
    const id = init(undefined);
    fs.rmSync(join(UPLOAD_BATCH_ROOT, id, '.batch.json'));
    expect(uploadBatchAccess(id, OWNER_A)).toBe('ok');
  });

  it('batchId malformato → invalid, assert → 400; lotto inesistente o altrui → 404', () => {
    expect(uploadBatchAccess('../../etc', OWNER_A)).toBe('invalid');
    expect(uploadBatchAccess(undefined, OWNER_A)).toBe('invalid');
    expect(() => assertUploadBatchAccess('non-un-uuid', OWNER_A)).toThrow(BadRequestException);
    expect(() => assertUploadBatchAccess(undefined, OWNER_A)).toThrow(BadRequestException);
    expect(() => assertUploadBatchAccess(randomUUID(), OWNER_A)).toThrow(NotFoundException);
    expect(() => assertUploadBatchAccess(init(OWNER_A), OWNER_B)).toThrow(NotFoundException);
  });

  it('i metadati del lotto non compaiono tra i file e non spostano la numerazione', () => {
    const id = init(OWNER_A);
    addToUploadBatch(id, assembled('a.zip'), 'a.zip');
    addToUploadBatch(id, assembled('b.zip'), 'b.zip');
    const files = listUploadBatchFiles(id);
    expect(files.map((f) => f.filename)).toEqual(['a.zip', 'b.zip']);
    expect(files.map((f) => f.path.split('/').pop())).toEqual(['0000_a.zip', '0001_b.zip']);
  });

  it('completamento una sola volta: dopo, il lotto risulta inesistente per add/complete', () => {
    const id = init(OWNER_A);
    expect(claimUploadBatch(id)).toBe(true);
    expect(claimUploadBatch(id)).toBe(false);
    // Marcatore = directory creata in modo atomico (mkdir non ricorsivo), mai un file.
    expect(fs.lstatSync(join(UPLOAD_BATCH_ROOT, id, '.completed')).isDirectory()).toBe(true);
    expect(listUploadBatchFiles(id)).toEqual([]);
    expect(uploadBatchAccess(id, OWNER_A)).toBe('not-found');
    // Pezzo arrivato dopo il complete (race): 404 come un lotto inesistente.
    expect(() => addToUploadBatch(id, assembled('c.zip'), 'c.zip')).toThrow(NotFoundException);
    // I file restano per il job di merge, che li consuma e poi pulisce.
    expect(fs.existsSync(join(UPLOAD_BATCH_ROOT, id))).toBe(true);
  });

  it('init: il lotto nasce con i soli metadati (owner)', () => {
    const id = init(OWNER_A);
    const dir = join(UPLOAD_BATCH_ROOT, id);
    expect(fs.readdirSync(dir)).toEqual(['.batch.json']);
    expect(JSON.parse(fs.readFileSync(join(dir, '.batch.json'), 'utf8'))).toEqual({ owner: OWNER_A });
  });

  it('claim su lotto inesistente o id malformato → false', () => {
    expect(claimUploadBatch(randomUUID())).toBe(false);
    expect(claimUploadBatch('../x')).toBe(false);
  });
});

describe('sweepStaleUploadBatches', () => {
  let root: string;
  let outside: string;
  const NOW = Date.parse('2026-11-14T12:00:00Z');
  const OLD = new Date(NOW - UPLOAD_BATCH_MAX_AGE_MS - 60_000);
  const RECENT = new Date(NOW - 60_000);

  // Radice di test in mkdtemp (mai UPLOAD_BATCH_ROOT): `completedAt` = mtime di `.completed`.
  function batch(mtime: Date, completed = false, completedAt: Date = RECENT): string {
    const dir = join(root, randomUUID());
    fs.mkdirSync(dir);
    fs.writeFileSync(join(dir, '0000_a.zip'), 'zip');
    if (completed) {
      fs.mkdirSync(join(dir, '.completed'));
      fs.utimesSync(join(dir, '.completed'), completedAt, completedAt);
    }
    fs.utimesSync(dir, mtime, mtime);
    return dir;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'batch-sweep-'));
    outside = mkdtempSync(join(tmpdir(), 'batch-sweep-outside-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('età massima di 24 h', () => {
    expect(UPLOAD_BATCH_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('rimuove i lotti non completati più vecchi di 24 h, lascia i recenti', () => {
    const old = batch(OLD);
    const fresh = batch(RECENT);
    expect(sweepStaleUploadBatches(root, UPLOAD_BATCH_MAX_AGE_MS, NOW)).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(join(fresh, '0000_a.zip'))).toBe(true);
  });

  it('un lotto completato (file in attesa del job di merge) resta, anche se più vecchio di 24 h', () => {
    const completed = batch(OLD, true);
    expect(sweepStaleUploadBatches(root, UPLOAD_BATCH_MAX_AGE_MS, NOW)).toBe(0);
    expect(fs.existsSync(join(completed, '0000_a.zip'))).toBe(true);
  });

  it('lotto completato orfano (job mai eseguito, .completed oltre 7 giorni) → rimosso', () => {
    expect(UPLOAD_BATCH_COMPLETED_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
    const orphanTime = new Date(NOW - UPLOAD_BATCH_COMPLETED_MAX_AGE_MS - 60_000);
    const withinTime = new Date(NOW - UPLOAD_BATCH_COMPLETED_MAX_AGE_MS + 60 * 60_000);
    const orphan = batch(orphanTime, true, orphanTime);
    const waiting = batch(withinTime, true, withinTime);
    expect(sweepStaleUploadBatches(root, UPLOAD_BATCH_MAX_AGE_MS, NOW)).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(join(waiting, '0000_a.zip'))).toBe(true);
  });

  it('nomi non UUID, file e symlink ignorati: mai fuori dalla radice', () => {
    const notUuid = join(root, 'non-un-uuid');
    fs.mkdirSync(notUuid);
    fs.utimesSync(notUuid, OLD, OLD);
    const file = join(root, randomUUID());
    fs.writeFileSync(file, 'x');
    fs.writeFileSync(join(outside, 'dato.zip'), 'zip');
    const link = join(root, randomUUID());
    fs.symlinkSync(outside, link);

    expect(sweepStaleUploadBatches(root, UPLOAD_BATCH_MAX_AGE_MS, NOW)).toBe(0);
    expect(fs.existsSync(notUuid)).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(join(outside, 'dato.zip'), 'utf8')).toBe('zip');
  });

  it('cartelle di staging di un init interrotto: rimosse dopo 24 h, recenti lasciate', () => {
    const stale = join(root, '.staging-Ab12Cd');
    fs.mkdirSync(stale);
    fs.writeFileSync(join(stale, '.batch.json'), '{}');
    fs.utimesSync(stale, OLD, OLD);
    const fresh = join(root, '.staging-Xy34Zw');
    fs.mkdirSync(fresh);
    fs.utimesSync(fresh, RECENT, RECENT);
    expect(sweepStaleUploadBatches(root, UPLOAD_BATCH_MAX_AGE_MS, NOW)).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('staging: symlink, file e nomi fuori schema ignorati', () => {
    fs.writeFileSync(join(outside, 'dato.zip'), 'zip');
    const link = join(root, '.staging-Lnk123');
    fs.symlinkSync(outside, link);
    const file = join(root, '.staging-File12');
    fs.writeFileSync(file, 'x');
    const odd = join(root, '.staging-troppo-lungo');
    fs.mkdirSync(odd);
    for (const p of [file, odd]) fs.utimesSync(p, OLD, OLD);

    expect(sweepStaleUploadBatches(root, UPLOAD_BATCH_MAX_AGE_MS, NOW)).toBe(0);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(join(outside, 'dato.zip'), 'utf8')).toBe('zip');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(odd)).toBe(true);
  });

  it('radice inesistente → 0', () => {
    expect(sweepStaleUploadBatches(join(root, 'manca'), UPLOAD_BATCH_MAX_AGE_MS, NOW)).toBe(0);
  });
});
