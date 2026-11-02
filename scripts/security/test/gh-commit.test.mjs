import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFileChanges } from '../gh-commit.mjs';

const read = (p) => Buffer.from(`contenuto di ${p}`);

test('modificati e aggiunti → additions base64, cancellati → deletions', () => {
  const status = ' M pnpm-lock.yaml\0 M apps/backend/package.json\0?? services/pdf-extractor/nuovo.txt\0 D vecchio.txt\0';
  assert.deepEqual(buildFileChanges(status, read), {
    additions: [
      { path: 'pnpm-lock.yaml', contents: Buffer.from('contenuto di pnpm-lock.yaml').toString('base64') },
      { path: 'apps/backend/package.json', contents: Buffer.from('contenuto di apps/backend/package.json').toString('base64') },
      { path: 'services/pdf-extractor/nuovo.txt', contents: Buffer.from('contenuto di services/pdf-extractor/nuovo.txt').toString('base64') },
    ],
    deletions: [{ path: 'vecchio.txt' }],
  });
});

test('rinomina (porcelain -z: R nuovo\\0vecchio) → addition + deletion', () => {
  const r = buildFileChanges('R  b.txt\0a.txt\0', read);
  assert.deepEqual(r.additions.map((x) => x.path), ['b.txt']);
  assert.deepEqual(r.deletions, [{ path: 'a.txt' }]);
});

test('file sotto .cache/ ignorati (scan e tool)', () => {
  const r = buildFileChanges('?? .cache/autofix/audit.json\0 M pnpm-lock.yaml\0', read);
  assert.deepEqual(r.additions.map((x) => x.path), ['pnpm-lock.yaml']);
});

test('nessuna modifica → liste vuote', () => assert.deepEqual(buildFileChanges('', read), { additions: [], deletions: [] }));
